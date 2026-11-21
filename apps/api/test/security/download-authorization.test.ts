import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import type {
  AuthorizationRepository,
  AuthorizedDocumentQueryScope,
  LoadedAuthorizationSubject,
} from "@docuflow/database";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditListFilter,
  AuditRepositoryPort,
  CreateDocumentInput,
  CreateDocumentVersionInput,
  DocumentEntity,
  DocumentListFilter,
  DocumentRepositoryPort,
  DocumentVersionEntity,
  DocumentVersionRepositoryPort,
  FileObjectEntity,
  FinalizeUploadToQuarantineInput,
  MarkFileObjectProcessedInput,
  MarkUploadReceivedInput,
  PaginatedResult,
  StorageConnectionEntity,
  StorageConnectionRepositoryPort,
  UpdateDocumentInput,
  UploadSessionEntity,
  UploadSessionRepositoryPort,
} from "@docuflow/domain";
import { type StorageProvider, createStorageProviderRegistry } from "@docuflow/storage-core";
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

function parseCookies(setCookieHeader: string | string[] | undefined): Record<string, string> {
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  const result: Record<string, string> = {};
  for (const item of list) {
    const firstPart = item.split(";")[0];
    if (!firstPart) {
      continue;
    }
    const idx = firstPart.indexOf("=");
    if (idx > 0) {
      result[firstPart.slice(0, idx).trim()] = firstPart.slice(idx + 1).trim();
    }
  }
  return result;
}

function createDownloadSecurityHarness(localRoot: string) {
  const fixedNow = new Date("2026-11-21T14:00:00.000Z");

  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const categoryId = randomUUID();
  const rootFolderId = randomUUID();
  const childFolderId = randomUUID();

  const downloaderId = randomUUID();
  const readOnlyUserId = randomUUID();
  const deniedUserId = randomUUID();
  const otherOrgUserId = randomUUID();

  const viewerRoleId = randomUUID();
  const readOnlyRoleId = randomUUID();

  const localConnId = randomUUID();
  const s3ConnId = randomUUID();
  const disabledConnId = randomUUID();
  const otherOrgConnId = randomUUID();

  const providerCalls: string[] = [];
  let s3TamperedChecksum = false;

  const sessions = new Map<string, StoredSessionRecord>();
  const usersByEmail = new Map<string, AuthCredentialRecord>();
  const subjects = new Map<string, LoadedAuthorizationSubject>();
  const documents = new Map<string, DocumentEntity>();
  const versions = new Map<string, DocumentVersionEntity>();
  const fileObjects = new Map<string, FileObjectEntity>();
  const fileObjectOrgIds = new Map<string, string>();
  const connections = new Map<string, StorageConnectionEntity>();
  const auditEvents: AuditEventRecord[] = [];

  connections.set(localConnId, {
    id: localConnId,
    organizationId: orgId,
    name: "Local Download Store",
    kind: "local",
    isDefault: true,
    status: "ACTIVE",
    nonSecretConfig: { rootDirectory: localRoot },
    encryptedSecretRef: null,
    lastHealthCheckAt: null,
    lastHealthMessage: null,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  });

  connections.set(s3ConnId, {
    id: s3ConnId,
    organizationId: orgId,
    name: "S3 Signed Store",
    kind: "s3",
    isDefault: false,
    status: "ACTIVE",
    nonSecretConfig: { bucket: "docuflow-downloads", region: "us-east-1" },
    encryptedSecretRef: "enc:s3-secret-ref",
    lastHealthCheckAt: null,
    lastHealthMessage: null,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  });

  connections.set(disabledConnId, {
    id: disabledConnId,
    organizationId: orgId,
    name: "Disabled Store",
    kind: "local",
    isDefault: false,
    status: "DISABLED",
    nonSecretConfig: { rootDirectory: localRoot },
    encryptedSecretRef: null,
    lastHealthCheckAt: null,
    lastHealthMessage: null,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  });

  connections.set(otherOrgConnId, {
    id: otherOrgConnId,
    organizationId: otherOrgId,
    name: "Foreign Org Store",
    kind: "local",
    isDefault: true,
    status: "ACTIVE",
    nonSecretConfig: { rootDirectory: localRoot },
    encryptedSecretRef: null,
    lastHealthCheckAt: null,
    lastHealthMessage: null,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  });

  const s3Contents = new Map<string, { readonly bytes: Buffer; readonly contentType: string }>();

  const storageRegistry = createStorageProviderRegistry({
    secretResolver: {
      async resolveSecret(encryptedSecretRef) {
        if (!encryptedSecretRef) {
          return null;
        }
        return { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" };
      },
    },
  });
  storageRegistry.registerFactory("local", (ctx) =>
    createLocalStorageProvider({
      rootDirectory: String(ctx.connection.nonSecretConfig.rootDirectory ?? localRoot),
    }),
  );
  storageRegistry.registerFactory("s3", () => {
    const s3Provider: StorageProvider = {
      kind: "s3",
      capabilities: {
        streamingRead: true,
        streamingWrite: true,
        signedUpload: true,
        signedDownload: true,
        multipartUpload: false,
        serverSideCopy: false,
      },
      async checkHealth() {
        return { healthy: true, message: "ok", checkedAt: fixedNow };
      },
      async putObject(input) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const buf = Buffer.concat(chunks);
        s3Contents.set(input.key.value, { bytes: buf, contentType: input.metadata.contentType });
        return {
          key: input.key,
          ...input.metadata,
        };
      },
      async getObject(key) {
        providerCalls.push(`s3:getObject:${key.value}`);
        const entry = s3Contents.get(key.value);
        if (!entry) {
          throw new Error("missing");
        }
        return {
          body: Readable.from(entry.bytes),
          metadata: {
            contentType: entry.contentType,
            contentLength: entry.bytes.length,
            checksumSha256: s3TamperedChecksum ? "f".repeat(64) : sha256Hex(entry.bytes),
          },
        };
      },
      async headObject(key) {
        const entry = s3Contents.get(key.value);
        if (!entry) {
          return null;
        }
        return {
          key,
          contentType: entry.contentType,
          contentLength: entry.bytes.length,
          checksumSha256: sha256Hex(entry.bytes),
        };
      },
      async deleteObject(key) {
        s3Contents.delete(key.value);
      },
      async createSignedDownloadTarget(input) {
        providerCalls.push(`s3:createSignedDownloadTarget:${input.key.value}`);
        const expiresAt = new Date(fixedNow.getTime() + input.expiresInSeconds * 1000);
        const queryName = input.downloadName
          ? `&response-content-disposition=${encodeURIComponent(`attachment; filename="${input.downloadName}"`)}`
          : "";
        return {
          url: `https://s3.example.internal/docuflow-downloads/${input.key.value}?X-Amz-Expires=${input.expiresInSeconds}&X-Amz-Signature=deadbeef${queryName}`,
          method: "GET",
          headers: {},
          expiresAt,
        };
      },
    };
    return s3Provider;
  });

  const sessionStore: SessionStorePort = {
    async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
      const record: StoredSessionRecord = {
        ...input,
        revokedAt: null,
        createdAt: fixedNow,
      };
      sessions.set(record.id, record);
      return record;
    },
    async findByTokenHash(tokenHash: string) {
      for (const s of sessions.values()) {
        if (s.tokenHash === tokenHash) {
          return s;
        }
      }
      return null;
    },
    async revokeById(sessionId, revokedAt) {
      const existing = sessions.get(sessionId);
      if (existing) {
        sessions.set(sessionId, { ...existing, revokedAt });
      }
    },
    async revokeAllForUser(userId, revokedAt) {
      for (const [id, s] of sessions.entries()) {
        if (s.userId === userId) {
          sessions.set(id, { ...s, revokedAt });
        }
      }
    },
  };

  const passwordService = createPasswordService({
    memoryCost: 8_192,
    timeCost: 2,
    parallelism: 1,
    minPasswordLength: 10,
  });
  const sessionService = createSessionService({
    store: sessionStore,
    now: () => fixedNow,
  });

  const authService = createAuthService({
    passwordService,
    sessionService,
    users: {
      async findCredentialByEmail(email) {
        return usersByEmail.get(email) ?? null;
      },
      async findProfileById(id) {
        const found = Array.from(usersByEmail.values()).find((u) => u.user.id === id);
        if (!found) {
          return null;
        }
        return {
          user: found.user,
          groups: [],
          roles: [],
          permissions: [],
        };
      },
    },
    now: () => fixedNow,
  });

  const authzRepository: AuthorizationRepository = {
    async loadSubject(targetOrgId: string, userId: string): Promise<LoadedAuthorizationSubject> {
      return (
        subjects.get(`${targetOrgId}:${userId}`) ?? {
          userId,
          organizationId: targetOrgId,
          groupIds: [],
          assignments: [],
          rolePermissions: [],
        }
      );
    },
    async loadFolderAncestorIds(_orgId: string, folderId: string | null) {
      if (folderId === childFolderId) {
        return [childFolderId, rootFolderId];
      }
      if (folderId === rootFolderId) {
        return [rootFolderId];
      }
      return [];
    },
    async expandFolderSubtreeIds(_orgId: string, rootIds: readonly string[]) {
      return rootIds;
    },
    async listAuthorizedDocuments(
      filter: DocumentListFilter,
      _scope: AuthorizedDocumentQueryScope,
    ): Promise<PaginatedResult<DocumentEntity>> {
      return {
        items: [],
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: 0,
        totalPages: 0,
      };
    },
  };

  const documentRepository: DocumentRepositoryPort = {
    async findById(id: string) {
      return documents.get(id) ?? null;
    },
    async list(filter: DocumentListFilter) {
      return {
        items: Array.from(documents.values()).filter(
          (d) => d.organizationId === filter.organizationId,
        ),
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: 0,
        totalPages: 0,
      };
    },
    async create(input: CreateDocumentInput) {
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
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
      };
      documents.set(doc.id, doc);
      return doc;
    },
    async updateWithOptimisticLock(_id: string, _expected: number, _input: UpdateDocumentInput) {
      return null;
    },
    async setCurrentVersion(docId: string, versionId: string) {
      const existing = documents.get(docId);
      if (!existing) {
        return null;
      }
      const next = { ...existing, currentVersionId: versionId, version: existing.version + 1 };
      documents.set(docId, next);
      return next;
    },
    async updateStatus(docId: string, status) {
      const existing = documents.get(docId);
      if (!existing) {
        return null;
      }
      const next = { ...existing, status, version: existing.version + 1 };
      documents.set(docId, next);
      return next;
    },
  };

  const documentVersionRepository: DocumentVersionRepositoryPort = {
    async findById(id: string) {
      return versions.get(id) ?? null;
    },
    async findByFileObjectId(fileObjectId: string) {
      return Array.from(versions.values()).find((v) => v.fileObjectId === fileObjectId) ?? null;
    },
    async findLatestByDocumentId(documentId: string) {
      const matches = Array.from(versions.values())
        .filter((v) => v.documentId === documentId)
        .sort((a, b) => b.versionNumber - a.versionNumber);
      return matches[0] ?? null;
    },
    async listByDocumentId(documentId: string) {
      return Array.from(versions.values()).filter((v) => v.documentId === documentId);
    },
    async create(input: CreateDocumentVersionInput) {
      const version: DocumentVersionEntity = {
        ...input,
        createdAt: fixedNow.toISOString(),
      };
      versions.set(version.id, version);
      return version;
    },
  };

  const uploadRepository: UploadSessionRepositoryPort = {
    async findById() {
      return null;
    },
    async findByIdempotencyKey() {
      return null;
    },
    async findFileObjectById(id: string) {
      return fileObjects.get(id) ?? null;
    },
    async findFileObjectOrganizationId(id: string) {
      return fileObjectOrgIds.get(id) ?? null;
    },
    async createSessionWithFileObject() {
      throw new Error("Not used in download test");
    },
    async markUploadReceived(_input: MarkUploadReceivedInput) {
      return null;
    },
    async finalizeToQuarantine(_input: FinalizeUploadToQuarantineInput) {
      return null;
    },
    async markFileObjectProcessed(_input: MarkFileObjectProcessedInput) {
      return null;
    },
    async markSessionExpired() {},
  };

  const storageConnections: StorageConnectionRepositoryPort = {
    async findById(id: string) {
      return connections.get(id) ?? null;
    },
    async listByOrganization(targetOrgId: string) {
      return Array.from(connections.values()).filter((c) => c.organizationId === targetOrgId);
    },
    async findDefaultActive(targetOrgId: string) {
      return (
        Array.from(connections.values()).find(
          (c) => c.organizationId === targetOrgId && c.isDefault && c.status === "ACTIVE",
        ) ?? null
      );
    },
    async create() {
      throw new Error("Not used");
    },
    async update() {
      return null;
    },
    async countFileObjects(connectionId: string) {
      return Array.from(fileObjects.values()).filter((f) => f.storageConnectionId === connectionId)
        .length;
    },
  };

  const auditRepository: AuditRepositoryPort = {
    async append(input: AuditEventInput) {
      const record: AuditEventRecord = {
        id: randomUUID(),
        organizationId: input.organizationId,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        result: input.result,
        requestId: input.requestId,
        metadata: input.metadata ?? {},
        occurredAt: fixedNow.toISOString(),
      };
      auditEvents.push(record);
      return record;
    },
    async list(filter: AuditListFilter) {
      return {
        items: auditEvents.filter((e) => e.organizationId === filter.organizationId),
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: auditEvents.length,
        totalPages: 1,
      };
    },
  };

  const registerUser = async (input: {
    readonly id: string;
    readonly organizationId: string;
    readonly email: string;
    readonly roleId: string;
    readonly roleKey: string;
    readonly scope: LoadedAuthorizationSubject["assignments"][number]["scope"];
    readonly extraAssignments?: LoadedAuthorizationSubject["assignments"];
    readonly permissions: LoadedAuthorizationSubject["rolePermissions"];
  }) => {
    const passwordHash = await passwordService.hashPassword("SenhaDownloadSegura123!");
    usersByEmail.set(input.email, {
      user: {
        id: input.id,
        organizationId: input.organizationId,
        email: input.email,
        fullName: input.email,
        status: "ACTIVE",
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
      },
      passwordHash,
    });
    subjects.set(`${input.organizationId}:${input.id}`, {
      userId: input.id,
      organizationId: input.organizationId,
      groupIds: [],
      assignments: [
        {
          roleId: input.roleId,
          roleKey: input.roleKey,
          scope: input.scope,
          effect: "ALLOW",
          source: "USER",
        },
        ...(input.extraAssignments ?? []),
      ],
      rolePermissions: input.permissions,
    });
  };

  const app = buildApp({
    authService,
    secureCookies: false,
    documentDeps: {
      authzRepository,
      documentRepository,
      auditRepository,
      documentVersionRepository,
      uploadRepository,
      storageConnections,
      storageRegistry,
    },
  });

  const login = async (email: string) => {
    const csrfRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
    });
    const csrfToken = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;
    const res = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/auth/login`,
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: csrfToken },
      payload: { email, password: "SenhaDownloadSegura123!" },
    });
    expect(res.statusCode).toBe(200);
    const cookies = {
      ...parseCookies(res.headers["set-cookie"]),
      [CSRF_COOKIE_NAME]: csrfToken,
    };
    return {
      cookies,
      csrfToken,
      postHeaders: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: csrfToken },
    };
  };

  return {
    app,
    fixedNow,
    orgId,
    otherOrgId,
    categoryId,
    rootFolderId,
    childFolderId,
    downloaderId,
    readOnlyUserId,
    deniedUserId,
    otherOrgUserId,
    viewerRoleId,
    readOnlyRoleId,
    localConnId,
    s3ConnId,
    disabledConnId,
    otherOrgConnId,
    documents,
    versions,
    fileObjects,
    fileObjectOrgIds,
    s3Contents,
    auditEvents,
    providerCalls,
    storageRegistry,
    setS3TamperedChecksum(value: boolean) {
      s3TamperedChecksum = value;
    },
    registerUser,
    login,
    seedDefaults: async () => {
      const viewerPermissions = SYSTEM_ROLE_DEFINITIONS.viewer.permissions.map((p) => ({
        roleId: viewerRoleId,
        roleKey: "viewer",
        action: p.action,
        resource: p.resource,
      }));
      await registerUser({
        id: downloaderId,
        organizationId: orgId,
        email: "downloader@docuflow.local",
        roleId: viewerRoleId,
        roleKey: "viewer",
        scope: { type: "FOLDER", folderId: rootFolderId },
        permissions: viewerPermissions,
      });

      // Role that can READ documents, but explicitly lacks DOWNLOAD permission
      await registerUser({
        id: readOnlyUserId,
        organizationId: orgId,
        email: "readonly-nodownload@docuflow.local",
        roleId: readOnlyRoleId,
        roleKey: "custom_readonly",
        scope: { type: "GLOBAL" },
        permissions: [
          {
            roleId: readOnlyRoleId,
            roleKey: "custom_readonly",
            action: "READ",
            resource: "DOCUMENT",
          },
        ],
      });

      // Inherits ALLOW on root folder, but has explicit DENY on child folder
      await registerUser({
        id: deniedUserId,
        organizationId: orgId,
        email: "denied-child@docuflow.local",
        roleId: viewerRoleId,
        roleKey: "viewer",
        scope: { type: "FOLDER", folderId: rootFolderId },
        extraAssignments: [
          {
            roleId: viewerRoleId,
            roleKey: "viewer",
            scope: { type: "FOLDER", folderId: childFolderId },
            effect: "DENY",
            source: "USER",
          },
        ],
        permissions: viewerPermissions,
      });

      await registerUser({
        id: otherOrgUserId,
        organizationId: otherOrgId,
        email: "foreign@otherorg.local",
        roleId: viewerRoleId,
        roleKey: "viewer",
        scope: { type: "GLOBAL" },
        permissions: viewerPermissions,
      });
    },
  };
}

describe("Authorized document download security suite", () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces authentication, DOWNLOAD authorization, DENY precedence, version ownership, file states, connection validity and filename sanitization", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "docuflow-dl-sec-"));
    tempDirs.push(tempRoot);

    const h = createDownloadSecurityHarness(tempRoot);
    await h.seedDefaults();

    const localPayload = Buffer.from("%PDF-1.4\n%Authorized Local Download\n", "utf8");
    const localHash = sha256Hex(localPayload);

    const docAllowedLocalId = randomUUID();
    const verAllowedLocalId = randomUUID();
    const fileAllowedLocalId = randomUUID();
    const localObjectKey = `org/${h.orgId}/documents/${docAllowedLocalId}/versions/${verAllowedLocalId}/${fileAllowedLocalId}`;

    const localProvider = createLocalStorageProvider({ rootDirectory: tempRoot });
    await localProvider.putObject({
      key: { value: localObjectKey },
      body: Readable.from(localPayload),
      metadata: {
        contentType: "application/pdf",
        contentLength: localPayload.length,
        checksumSha256: localHash,
      },
    });

    // Malicious filename with traversal + CRLF injection + quotes must be sanitized on delivery
    h.fileObjects.set(fileAllowedLocalId, {
      id: fileAllowedLocalId,
      storageConnectionId: h.localConnId,
      objectKey: localObjectKey,
      originalFileName: '../../evil\r\nX-Injected: yes".pdf',
      detectedContentType: "application/pdf",
      sizeBytes: localPayload.length,
      checksumSha256: localHash,
      status: "AVAILABLE",
      createdAt: h.fixedNow.toISOString(),
    });
    h.fileObjectOrgIds.set(fileAllowedLocalId, h.orgId);

    h.documents.set(docAllowedLocalId, {
      id: docAllowedLocalId,
      organizationId: h.orgId,
      title: "Contrato Local Disponível",
      categoryId: h.categoryId,
      folderId: h.rootFolderId,
      status: "APPROVED",
      currentVersionId: verAllowedLocalId,
      ownerUserId: h.downloaderId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
      version: 1,
      createdAt: h.fixedNow.toISOString(),
      updatedAt: h.fixedNow.toISOString(),
    });
    h.versions.set(verAllowedLocalId, {
      id: verAllowedLocalId,
      documentId: docAllowedLocalId,
      versionNumber: 1,
      fileObjectId: fileAllowedLocalId,
      uploadedByUserId: h.downloaderId,
      changeNote: null,
      createdAt: h.fixedNow.toISOString(),
    });

    // Child folder doc (explicit DENY test for deniedUserId)
    const docChildId = randomUUID();
    const verChildId = randomUUID();
    const fileChildId = randomUUID();
    h.fileObjects.set(fileChildId, {
      id: fileChildId,
      storageConnectionId: h.localConnId,
      objectKey: localObjectKey,
      originalFileName: "restrito.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: localPayload.length,
      checksumSha256: localHash,
      status: "AVAILABLE",
      createdAt: h.fixedNow.toISOString(),
    });
    h.fileObjectOrgIds.set(fileChildId, h.orgId);
    h.documents.set(docChildId, {
      id: docChildId,
      organizationId: h.orgId,
      title: "Documento Pasta Negada",
      categoryId: h.categoryId,
      folderId: h.childFolderId,
      status: "APPROVED",
      currentVersionId: verChildId,
      ownerUserId: h.downloaderId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
      version: 1,
      createdAt: h.fixedNow.toISOString(),
      updatedAt: h.fixedNow.toISOString(),
    });
    h.versions.set(verChildId, {
      id: verChildId,
      documentId: docChildId,
      versionNumber: 1,
      fileObjectId: fileChildId,
      uploadedByUserId: h.downloaderId,
      changeNote: null,
      createdAt: h.fixedNow.toISOString(),
    });

    // Quarantined & Rejected & Disabled-connection & Deleted docs
    const addRestrictedDoc = (
      status: FileObjectEntity["status"],
      connectionId: string,
      docStatus: DocumentEntity["status"] = "DRAFT",
    ) => {
      const docId = randomUUID();
      const verId = randomUUID();
      const fileId = randomUUID();
      h.fileObjects.set(fileId, {
        id: fileId,
        storageConnectionId: connectionId,
        objectKey: `org/${h.orgId}/blocked/${fileId}`,
        originalFileName: `blocked-${status.toLowerCase()}.pdf`,
        detectedContentType: "application/pdf",
        sizeBytes: 128,
        checksumSha256: "a".repeat(64),
        status,
        createdAt: h.fixedNow.toISOString(),
      });
      h.fileObjectOrgIds.set(fileId, h.orgId);
      h.documents.set(docId, {
        id: docId,
        organizationId: h.orgId,
        title: `Doc ${status}`,
        categoryId: h.categoryId,
        folderId: h.rootFolderId,
        status: docStatus,
        currentVersionId: verId,
        ownerUserId: h.downloaderId,
        issueDate: null,
        expirationDate: null,
        metadata: {},
        version: 1,
        createdAt: h.fixedNow.toISOString(),
        updatedAt: h.fixedNow.toISOString(),
      });
      h.versions.set(verId, {
        id: verId,
        documentId: docId,
        versionNumber: 1,
        fileObjectId: fileId,
        uploadedByUserId: h.downloaderId,
        changeNote: null,
        createdAt: h.fixedNow.toISOString(),
      });
      return { docId, verId };
    };

    const quarantinedDoc = addRestrictedDoc("QUARANTINED", h.localConnId);
    const rejectedDoc = addRestrictedDoc("REJECTED", h.localConnId);
    const uploadingDoc = addRestrictedDoc("UPLOADING", h.localConnId);
    const disabledProviderDoc = addRestrictedDoc("AVAILABLE", h.disabledConnId);
    const deletedDoc = addRestrictedDoc("AVAILABLE", h.localConnId, "DELETED");

    // Foreign org doc
    const foreignDocId = randomUUID();
    const foreignVerId = randomUUID();
    const foreignFileId = randomUUID();
    h.fileObjects.set(foreignFileId, {
      id: foreignFileId,
      storageConnectionId: h.otherOrgConnId,
      objectKey: `org/${h.otherOrgId}/foreign/${foreignFileId}`,
      originalFileName: "sigiloso.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 100,
      checksumSha256: "d".repeat(64),
      status: "AVAILABLE",
      createdAt: h.fixedNow.toISOString(),
    });
    h.fileObjectOrgIds.set(foreignFileId, h.otherOrgId);
    h.documents.set(foreignDocId, {
      id: foreignDocId,
      organizationId: h.otherOrgId,
      title: "Documento Outra Organização",
      categoryId: h.categoryId,
      folderId: null,
      status: "APPROVED",
      currentVersionId: foreignVerId,
      ownerUserId: h.otherOrgUserId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
      version: 1,
      createdAt: h.fixedNow.toISOString(),
      updatedAt: h.fixedNow.toISOString(),
    });
    h.versions.set(foreignVerId, {
      id: foreignVerId,
      documentId: foreignDocId,
      versionNumber: 1,
      fileObjectId: foreignFileId,
      uploadedByUserId: h.otherOrgUserId,
      changeNote: null,
      createdAt: h.fixedNow.toISOString(),
    });

    const downloaderSession = await h.login("downloader@docuflow.local");
    const readOnlySession = await h.login("readonly-nodownload@docuflow.local");
    const deniedSession = await h.login("denied-child@docuflow.local");
    const foreignSession = await h.login("foreign@otherorg.local");

    // 1. Unauthenticated access rejected on both target and stream endpoints
    const anonStream = await h.app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedLocalId}/download`,
    });
    expect(anonStream.statusCode).toBe(401);

    // 2. User with READ only (without DOWNLOAD) is blocked (403)
    const readOnlyTarget = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedLocalId}/download-target`,
      cookies: readOnlySession.cookies,
      headers: readOnlySession.postHeaders,
      payload: {},
    });
    expect(readOnlyTarget.statusCode).toBe(403);

    const readOnlyStream = await h.app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedLocalId}/download`,
      cookies: readOnlySession.cookies,
    });
    expect(readOnlyStream.statusCode).toBe(403);

    // 3. Explicit DENY on subfolder overrides inherited folder ALLOW
    const deniedTarget = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docChildId}/download-target`,
      cookies: deniedSession.cookies,
      headers: deniedSession.postHeaders,
      payload: {},
    });
    expect(deniedTarget.statusCode).toBe(403);

    // 4. Cross-organization IDOR blocked (even with GLOBAL role in other org)
    const crossOrgTarget = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedLocalId}/download-target`,
      cookies: foreignSession.cookies,
      headers: foreignSession.postHeaders,
      payload: {},
    });
    expect([403, 404]).toContain(crossOrgTarget.statusCode);

    // 5. Cross-document version swap IDOR blocked (valid docAllowedLocalId + verChildId/foreignVerId)
    const versionSwapTarget = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedLocalId}/download-target`,
      cookies: downloaderSession.cookies,
      headers: downloaderSession.postHeaders,
      payload: { versionId: foreignVerId },
    });
    expect(versionSwapTarget.statusCode).toBe(404);

    const versionSwapStream = await h.app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedLocalId}/download?versionId=${verChildId}`,
      cookies: downloaderSession.cookies,
    });
    expect(versionSwapStream.statusCode).toBe(404);

    // 6. Quarantined, rejected, uploading, deleted, and disabled-provider files never release targets
    const qTarget = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${quarantinedDoc.docId}/download-target`,
      cookies: downloaderSession.cookies,
      headers: downloaderSession.postHeaders,
      payload: {},
    });
    expect(qTarget.statusCode).toBe(409);
    expect(qTarget.json().error.code).toBe("FILE_QUARANTINED");

    const rStream = await h.app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${rejectedDoc.docId}/download`,
      cookies: downloaderSession.cookies,
    });
    expect(rStream.statusCode).toBe(409);
    expect(rStream.json().error.code).toBe("FILE_REJECTED");

    const uStream = await h.app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${uploadingDoc.docId}/download`,
      cookies: downloaderSession.cookies,
    });
    expect(uStream.statusCode).toBe(409);

    const deletedStream = await h.app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${deletedDoc.docId}/download`,
      cookies: downloaderSession.cookies,
    });
    expect(deletedStream.statusCode).toBe(404);

    const disabledConnTarget = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${disabledProviderDoc.docId}/download-target`,
      cookies: downloaderSession.cookies,
      headers: downloaderSession.postHeaders,
      payload: {},
    });
    expect(disabledConnTarget.statusCode).toBe(503);
    expect(disabledConnTarget.json().error.code).toBe("STORAGE_UNAVAILABLE");

    // Reject long TTL requests on download-target
    const excessiveTtlRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedLocalId}/download-target`,
      cookies: downloaderSession.cookies,
      headers: downloaderSession.postHeaders,
      payload: { expiresInSeconds: 3600 },
    });
    expect(excessiveTtlRes.statusCode).toBe(400);

    // Zero provider calls made so far for any denied/blocked request
    expect(h.providerCalls).toHaveLength(0);

    // 7. Authorized local download: API_STREAMING target + streaming download with sanitized filename & headers
    const localTargetRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedLocalId}/download-target`,
      cookies: downloaderSession.cookies,
      headers: downloaderSession.postHeaders,
      payload: { versionId: verAllowedLocalId },
    });
    expect(localTargetRes.statusCode).toBe(200);
    const localTargetBody = localTargetRes.json().data;
    expect(localTargetBody.mode).toBe("API_STREAMING");
    expect(localTargetBody.url).toBe(
      `${CONTRACTS_API_PREFIX}/documents/${docAllowedLocalId}/download?versionId=${verAllowedLocalId}`,
    );
    expect(localTargetBody.fileName).not.toContain("/");
    expect(localTargetBody.fileName).not.toContain("..");
    expect(localTargetBody.fileName).not.toContain("\r");
    expect(localTargetBody.fileName).not.toContain("\n");

    const streamRes = await h.app.inject({
      method: "GET",
      url: localTargetBody.url,
      cookies: downloaderSession.cookies,
    });
    expect(streamRes.statusCode).toBe(200);
    expect(streamRes.rawPayload.equals(localPayload)).toBe(true);
    expect(streamRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(streamRes.headers["cache-control"]).toContain("private");
    expect(streamRes.headers["cache-control"]).toContain("no-store");
    expect(streamRes.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(String(streamRes.headers["content-disposition"])).toBe(
      'attachment; filename="evilX-Injected__yes_.pdf"',
    );

    await h.app.close();
  });

  it("issues short-lived signed download URLs for signed-capable providers, supports API streaming fallback, redacts audit metadata and fails closed on checksum mismatch", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "docuflow-dl-signed-"));
    tempDirs.push(tempRoot);

    const h = createDownloadSecurityHarness(tempRoot);
    await h.seedDefaults();

    const s3Payload = Buffer.from("PNG_BINARY_CONTENT_TEST", "utf8");
    const s3Hash = sha256Hex(s3Payload);
    const docS3Id = randomUUID();
    const verS3Id = randomUUID();
    const fileS3Id = randomUUID();
    const s3Key = `org/${h.orgId}/documents/${docS3Id}/versions/${verS3Id}/${fileS3Id}`;

    h.s3Contents.set(s3Key, { bytes: s3Payload, contentType: "image/png" });
    h.fileObjects.set(fileS3Id, {
      id: fileS3Id,
      storageConnectionId: h.s3ConnId,
      objectKey: s3Key,
      originalFileName: "comprovante.png",
      detectedContentType: "image/png",
      sizeBytes: s3Payload.length,
      checksumSha256: s3Hash,
      status: "AVAILABLE",
      createdAt: h.fixedNow.toISOString(),
    });
    h.fileObjectOrgIds.set(fileS3Id, h.orgId);

    h.documents.set(docS3Id, {
      id: docS3Id,
      organizationId: h.orgId,
      title: "Comprovante S3",
      categoryId: h.categoryId,
      folderId: h.rootFolderId,
      status: "APPROVED",
      currentVersionId: verS3Id,
      ownerUserId: h.downloaderId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
      version: 1,
      createdAt: h.fixedNow.toISOString(),
      updatedAt: h.fixedNow.toISOString(),
    });
    h.versions.set(verS3Id, {
      id: verS3Id,
      documentId: docS3Id,
      versionNumber: 1,
      fileObjectId: fileS3Id,
      uploadedByUserId: h.downloaderId,
      changeNote: null,
      createdAt: h.fixedNow.toISOString(),
    });

    const downloaderSession = await h.login("downloader@docuflow.local");

    // 1. Signed target returned with short TTL (default 60s) and private no-cache headers
    const signedRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docS3Id}/download-target`,
      cookies: downloaderSession.cookies,
      headers: downloaderSession.postHeaders,
      payload: {},
    });
    expect(signedRes.statusCode).toBe(200);
    expect(signedRes.headers["cache-control"]).toContain("private");
    expect(signedRes.headers["cache-control"]).toContain("no-store");

    const signedData = signedRes.json().data;
    expect(signedData.mode).toBe("SIGNED_URL");
    expect(signedData.url).toContain("X-Amz-Signature=deadbeef");
    expect(signedData.expiresAt).toBe("2026-11-21T14:01:00.000Z");
    expect(signedData.target.method).toBe("GET");

    // Audit log must record DOCUMENT_DOWNLOADED WITHOUT leaking the signed URL or signature
    const downloadAudit = h.auditEvents.find((e) => e.action === "DOCUMENT_DOWNLOADED");
    expect(downloadAudit).toBeDefined();
    expect(JSON.stringify(downloadAudit)).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(downloadAudit)).not.toContain("deadbeef");
    expect(JSON.stringify(downloadAudit)).not.toContain("https://s3.example.internal");

    // 2. Explicit streaming fallback when preferSigned=false
    const fallbackTargetRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docS3Id}/download-target`,
      cookies: downloaderSession.cookies,
      headers: downloaderSession.postHeaders,
      payload: { preferSigned: false },
    });
    expect(fallbackTargetRes.statusCode).toBe(200);
    expect(fallbackTargetRes.json().data.mode).toBe("API_STREAMING");

    // 3. Checksum mismatch fails closed on streaming download
    h.setS3TamperedChecksum(true);
    const tamperedStreamRes = await h.app.inject({
      method: "GET",
      url: fallbackTargetRes.json().data.url,
      cookies: downloaderSession.cookies,
    });
    expect(tamperedStreamRes.statusCode).toBe(409);
    expect(h.auditEvents.some((e) => e.action === "DOCUMENT_DOWNLOAD_FAILED")).toBe(true);

    await h.app.close();
  });
});
