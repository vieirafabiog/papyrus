import { randomUUID } from "node:crypto";
import {
  type CreateSessionRecordInput,
  type PermissionPair,
  SYSTEM_ROLE_DEFINITIONS,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
  evaluateDocumentAuthorization,
} from "@papyrus/auth";
import { CONTRACTS_API_PREFIX } from "@papyrus/contracts";
import type {
  AuthorizationRepository,
  AuthorizedDocumentQueryScope,
  LoadedAuthorizationSubject,
  LoadedRoleAssignment,
  LoadedRolePermission,
} from "@papyrus/database";
import {
  type AuditEventInput,
  type AuditEventRecord,
  type AuditListFilter,
  type AuditRepositoryPort,
  type CreateDocumentInput,
  type DocumentEntity,
  type DocumentListFilter,
  type DocumentRepositoryPort,
  type FileObjectStatus,
  type GroupAdministrationService,
  type PaginatedResult,
  type UpdateDocumentInput,
  type UserAdministrationService,
  type UserEntity,
  isFileObjectDownloadable,
} from "@papyrus/domain";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  type AuthCredentialRecord,
  type AuthUserLookupPort,
  createAuthService,
} from "../../src/modules/auth/auth.service.js";
import {
  buildRolePermissionsLookup,
  createDocumentAuthorizationGuard,
  toSubjectContext,
} from "../../src/plugins/authorization.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

interface FolderNode {
  readonly id: string;
  readonly organizationId: string;
  readonly parentId: string | null;
}

interface TestHarnessState {
  readonly documents: Map<string, DocumentEntity>;
  readonly folders: Map<string, FolderNode>;
  readonly subjects: Map<string, LoadedAuthorizationSubject>;
  readonly auditEvents: AuditEventRecord[];
  userAdminMutations: number;
  groupAdminMutations: number;
}

function createMemorySessionStore(): SessionStorePort {
  const store = new Map<string, StoredSessionRecord>();
  return {
    async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
      const record: StoredSessionRecord = {
        ...input,
        revokedAt: null,
        createdAt: new Date(),
      };
      store.set(record.id, record);
      return record;
    },
    async findByTokenHash(tokenHash: string): Promise<StoredSessionRecord | null> {
      for (const item of store.values()) {
        if (item.tokenHash === tokenHash) {
          return item;
        }
      }
      return null;
    },
    async revokeById(sessionId: string, revokedAt: Date): Promise<void> {
      const existing = store.get(sessionId);
      if (existing) {
        store.set(sessionId, { ...existing, revokedAt });
      }
    },
    async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
      for (const [id, existing] of store.entries()) {
        if (existing.userId === userId && existing.revokedAt === null) {
          store.set(id, { ...existing, revokedAt });
        }
      }
    },
  };
}

function createInMemoryRepositories(state: TestHarnessState): {
  readonly authzRepository: AuthorizationRepository;
  readonly documentRepository: DocumentRepositoryPort;
  readonly auditRepository: AuditRepositoryPort;
  readonly userAdminService: UserAdministrationService;
  readonly groupAdminService: GroupAdministrationService;
} {
  const expandSubtree = (organizationId: string, rootFolderIds: readonly string[]): string[] => {
    const expanded = new Set<string>();
    const queue = [...rootFolderIds];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || expanded.has(current)) {
        continue;
      }
      const node = state.folders.get(current);
      if (!node || node.organizationId !== organizationId) {
        continue;
      }
      expanded.add(current);
      for (const candidate of state.folders.values()) {
        if (
          candidate.organizationId === organizationId &&
          candidate.parentId === current &&
          !expanded.has(candidate.id)
        ) {
          queue.push(candidate.id);
        }
      }
    }
    return Array.from(expanded);
  };

  const authzRepository: AuthorizationRepository = {
    async loadSubject(organizationId: string, userId: string): Promise<LoadedAuthorizationSubject> {
      const subject = state.subjects.get(`${organizationId}:${userId}`);
      if (!subject) {
        return {
          userId,
          organizationId,
          groupIds: [],
          assignments: [],
          rolePermissions: [],
        };
      }
      return subject;
    },

    async loadFolderAncestorIds(
      organizationId: string,
      folderId: string | null,
    ): Promise<readonly string[]> {
      if (!folderId) {
        return [];
      }
      const ancestors: string[] = [];
      const visited = new Set<string>();
      let current: string | null = folderId;
      while (current && !visited.has(current)) {
        visited.add(current);
        const node = state.folders.get(current);
        if (!node || node.organizationId !== organizationId) {
          break;
        }
        ancestors.push(node.id);
        current = node.parentId;
      }
      return ancestors;
    },

    async expandFolderSubtreeIds(
      organizationId: string,
      rootFolderIds: readonly string[],
    ): Promise<readonly string[]> {
      return expandSubtree(organizationId, rootFolderIds);
    },

    async listAuthorizedDocuments(
      filter: DocumentListFilter,
      scope: AuthorizedDocumentQueryScope,
    ): Promise<PaginatedResult<DocumentEntity>> {
      const hasAnyAllow =
        scope.hasGlobalAllow ||
        scope.allowedCategoryIds.length > 0 ||
        scope.allowedFolderIds.length > 0 ||
        scope.allowedDocumentIds.length > 0;

      if (scope.hasGlobalDeny || !hasAnyAllow) {
        return {
          items: [],
          page: filter.page,
          pageSize: filter.pageSize,
          totalItems: 0,
          totalPages: 0,
        };
      }

      const expandedAllowedFolders = new Set(
        expandSubtree(filter.organizationId, scope.allowedFolderIds),
      );
      const expandedDeniedFolders = new Set(
        expandSubtree(filter.organizationId, scope.deniedFolderIds),
      );
      const allowedCategories = new Set(scope.allowedCategoryIds);
      const allowedDocs = new Set(scope.allowedDocumentIds);
      const deniedCategories = new Set(scope.deniedCategoryIds);
      const deniedDocs = new Set(scope.deniedDocumentIds);

      const authorized = Array.from(state.documents.values()).filter((doc) => {
        if (doc.organizationId !== filter.organizationId) {
          return false;
        }
        if (filter.status !== undefined) {
          if (doc.status !== filter.status) {
            return false;
          }
        } else if (doc.status === "DELETED") {
          return false;
        }
        if (filter.categoryId !== undefined && doc.categoryId !== filter.categoryId) {
          return false;
        }
        if (filter.folderId !== undefined && doc.folderId !== filter.folderId) {
          return false;
        }
        if (
          filter.search !== undefined &&
          filter.search.trim().length > 0 &&
          !doc.title.toLowerCase().includes(filter.search.trim().toLowerCase())
        ) {
          return false;
        }

        const isAllowed =
          scope.hasGlobalAllow ||
          allowedCategories.has(doc.categoryId) ||
          (doc.folderId !== null && expandedAllowedFolders.has(doc.folderId)) ||
          allowedDocs.has(doc.id);

        if (!isAllowed) {
          return false;
        }
        if (deniedCategories.has(doc.categoryId) || deniedDocs.has(doc.id)) {
          return false;
        }
        if (doc.folderId !== null && expandedDeniedFolders.has(doc.folderId)) {
          return false;
        }
        return true;
      });

      const totalItems = authorized.length;
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);
      const start = (filter.page - 1) * filter.pageSize;
      const items = authorized.slice(start, start + filter.pageSize);

      return {
        items,
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages,
      };
    },
  };

  const documentRepository: DocumentRepositoryPort = {
    async findById(id: string): Promise<DocumentEntity | null> {
      return state.documents.get(id) ?? null;
    },
    async listByFilter(filter: DocumentListFilter): Promise<PaginatedResult<DocumentEntity>> {
      const items = Array.from(state.documents.values()).filter(
        (doc) => doc.organizationId === filter.organizationId,
      );
      return {
        items,
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: items.length,
        totalPages: Math.ceil(items.length / filter.pageSize),
      };
    },
    async create(input: CreateDocumentInput): Promise<DocumentEntity> {
      const now = new Date().toISOString();
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
        createdAt: now,
        updatedAt: now,
      };
      state.documents.set(doc.id, doc);
      return doc;
    },
    async updateWithOptimisticLock(
      id: string,
      expectedVersion: number,
      input: UpdateDocumentInput,
    ): Promise<DocumentEntity | null> {
      const existing = state.documents.get(id);
      if (!existing || existing.version !== expectedVersion) {
        return null;
      }
      const updated: DocumentEntity = {
        ...existing,
        title: input.title ?? existing.title,
        categoryId: input.categoryId ?? existing.categoryId,
        folderId: input.folderId !== undefined ? input.folderId : existing.folderId,
        status: input.status ?? existing.status,
        currentVersionId:
          input.currentVersionId !== undefined ? input.currentVersionId : existing.currentVersionId,
        issueDate: input.issueDate !== undefined ? input.issueDate : existing.issueDate,
        expirationDate:
          input.expirationDate !== undefined ? input.expirationDate : existing.expirationDate,
        metadata: input.metadata ?? existing.metadata,
        version: existing.version + 1,
        updatedAt: new Date().toISOString(),
      };
      state.documents.set(id, updated);
      return updated;
    },
  };

  const auditRepository: AuditRepositoryPort = {
    async append(input: AuditEventInput): Promise<AuditEventRecord> {
      const record: AuditEventRecord = {
        id: randomUUID(),
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        result: input.result,
        requestId: input.requestId,
        occurredAt: new Date().toISOString(),
        metadata: input.metadata ?? {},
      };
      state.auditEvents.push(record);
      return record;
    },
    async listByOrganization(filter: AuditListFilter): Promise<PaginatedResult<AuditEventRecord>> {
      const filtered = state.auditEvents.filter(
        (item) => item.organizationId === filter.organizationId,
      );
      return {
        items: filtered,
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: filtered.length,
        totalPages: Math.ceil(filtered.length / filter.pageSize),
      };
    },
  };

  const userAdminService: UserAdministrationService = {
    async listUsers(): Promise<readonly UserEntity[]> {
      return [];
    },
    async createUser(): Promise<UserEntity> {
      state.userAdminMutations += 1;
      throw new Error("Should not be called by unauthorized actor");
    },
    async updateUser(): Promise<UserEntity> {
      state.userAdminMutations += 1;
      throw new Error("Should not be called by unauthorized actor");
    },
    async deactivateUser(): Promise<UserEntity> {
      state.userAdminMutations += 1;
      throw new Error("Should not be called by unauthorized actor");
    },
    async reactivateUser(): Promise<UserEntity> {
      state.userAdminMutations += 1;
      throw new Error("Should not be called by unauthorized actor");
    },
  };

  const groupAdminService: GroupAdministrationService = {
    async listGroups() {
      return [];
    },
    async createGroup() {
      state.groupAdminMutations += 1;
      throw new Error("Should not be called by unauthorized actor");
    },
    async listMembers() {
      return [];
    },
    async addMember() {
      state.groupAdminMutations += 1;
    },
    async removeMember() {
      state.groupAdminMutations += 1;
    },
  };

  return {
    authzRepository,
    documentRepository,
    auditRepository,
    userAdminService,
    groupAdminService,
  };
}

function buildLoadedPermissions(
  roleId: string,
  roleKey: string,
  pairs: readonly PermissionPair[],
): LoadedRolePermission[] {
  return pairs.map((pair) => ({
    roleId,
    roleKey,
    action: pair.action,
    resource: pair.resource,
  }));
}

describe("Negative access control & authorization security tests", () => {
  it("prevents IDOR, existence enumeration, cross-tenant leakage, and count leakage across listing/search", async () => {
    const orgA = "10000000-0000-4000-8000-000000000001";
    const orgB = "10000000-0000-4000-8000-000000000002";

    const catPublic = "20000000-0000-4000-8000-000000000001";
    const catConfidential = "20000000-0000-4000-8000-000000000002";
    const catOrgB = "20000000-0000-4000-8000-000000000003";

    const folderRoot = "30000000-0000-4000-8000-000000000001";
    const folderChildAllowed = "30000000-0000-4000-8000-000000000002";
    const folderChildDenied = "30000000-0000-4000-8000-000000000003";
    const folderGrandchildDenied = "30000000-0000-4000-8000-000000000004";

    const docAllowedId = "40000000-0000-4000-8000-000000000001";
    const docDeniedFolderId = "40000000-0000-4000-8000-000000000002";
    const docDeniedGrandchildId = "40000000-0000-4000-8000-000000000003";
    const docDeniedExplicitId = "40000000-0000-4000-8000-000000000004";
    const docConfidentialCatId = "40000000-0000-4000-8000-000000000005";
    const docOrgBId = "40000000-0000-4000-8000-000000000006";
    const nonExistentDocId = "40000000-0000-4000-8000-999999999999";

    const userScopedId = "50000000-0000-4000-8000-000000000001";
    const userViewerId = "50000000-0000-4000-8000-000000000002";
    const userGlobalAdminAId = "50000000-0000-4000-8000-000000000003";

    const roleCollabId = "60000000-0000-4000-8000-000000000001";
    const roleViewerId = "60000000-0000-4000-8000-000000000002";
    const roleAdminId = "60000000-0000-4000-8000-000000000003";

    const now = "2026-11-20T12:00:00.000Z";
    const makeDoc = (
      id: string,
      organizationId: string,
      title: string,
      categoryId: string,
      folderId: string | null,
      ownerUserId: string,
    ): DocumentEntity => ({
      id,
      organizationId,
      title,
      categoryId,
      folderId,
      status: "DRAFT",
      currentVersionId: null,
      ownerUserId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    const state: TestHarnessState = {
      folders: new Map<string, FolderNode>([
        [folderRoot, { id: folderRoot, organizationId: orgA, parentId: null }],
        [
          folderChildAllowed,
          { id: folderChildAllowed, organizationId: orgA, parentId: folderRoot },
        ],
        [folderChildDenied, { id: folderChildDenied, organizationId: orgA, parentId: folderRoot }],
        [
          folderGrandchildDenied,
          { id: folderGrandchildDenied, organizationId: orgA, parentId: folderChildDenied },
        ],
      ]),
      documents: new Map<string, DocumentEntity>([
        [
          docAllowedId,
          makeDoc(
            docAllowedId,
            orgA,
            "Manual Operacional Público",
            catPublic,
            folderChildAllowed,
            userScopedId,
          ),
        ],
        [
          docDeniedFolderId,
          makeDoc(
            docDeniedFolderId,
            orgA,
            "Folha Salarial Sigiloso",
            catPublic,
            folderChildDenied,
            userGlobalAdminAId,
          ),
        ],
        [
          docDeniedGrandchildId,
          makeDoc(
            docDeniedGrandchildId,
            orgA,
            "Bônus Executivo Sigiloso",
            catPublic,
            folderGrandchildDenied,
            userGlobalAdminAId,
          ),
        ],
        [
          docDeniedExplicitId,
          makeDoc(
            docDeniedExplicitId,
            orgA,
            "Exceção Jurídica Sigiloso",
            catPublic,
            folderChildAllowed,
            userGlobalAdminAId,
          ),
        ],
        [
          docConfidentialCatId,
          makeDoc(
            docConfidentialCatId,
            orgA,
            "Fusão Estratégica Sigiloso",
            catConfidential,
            null,
            userGlobalAdminAId,
          ),
        ],
        [
          docOrgBId,
          makeDoc(
            docOrgBId,
            orgB,
            "Documento Tenant B",
            catOrgB,
            null,
            "50000000-0000-4000-8000-000000000099",
          ),
        ],
      ]),
      subjects: new Map<string, LoadedAuthorizationSubject>([
        [
          `${orgA}:${userScopedId}`,
          {
            userId: userScopedId,
            organizationId: orgA,
            groupIds: [],
            assignments: [
              {
                roleId: roleCollabId,
                roleKey: "collaborator",
                scope: { type: "FOLDER", folderId: folderRoot },
                effect: "ALLOW",
                source: "USER",
              },
              {
                roleId: roleCollabId,
                roleKey: "collaborator",
                scope: { type: "FOLDER", folderId: folderChildDenied },
                effect: "DENY",
                source: "USER",
              },
              {
                roleId: roleCollabId,
                roleKey: "collaborator",
                scope: { type: "DOCUMENT", documentId: docDeniedExplicitId },
                effect: "DENY",
                source: "USER",
              },
            ],
            rolePermissions: buildLoadedPermissions(
              roleCollabId,
              "collaborator",
              SYSTEM_ROLE_DEFINITIONS.collaborator.permissions,
            ),
          },
        ],
        [
          `${orgA}:${userViewerId}`,
          {
            userId: userViewerId,
            organizationId: orgA,
            groupIds: [],
            assignments: [
              {
                roleId: roleViewerId,
                roleKey: "viewer",
                scope: { type: "DOCUMENT", documentId: docAllowedId },
                effect: "ALLOW",
                source: "USER",
              },
            ],
            rolePermissions: buildLoadedPermissions(
              roleViewerId,
              "viewer",
              SYSTEM_ROLE_DEFINITIONS.viewer.permissions,
            ),
          },
        ],
        [
          `${orgA}:${userGlobalAdminAId}`,
          {
            userId: userGlobalAdminAId,
            organizationId: orgA,
            groupIds: [],
            assignments: [
              {
                roleId: roleAdminId,
                roleKey: "admin",
                scope: { type: "GLOBAL" },
                effect: "ALLOW",
                source: "USER",
              },
            ],
            rolePermissions: buildLoadedPermissions(
              roleAdminId,
              "admin",
              SYSTEM_ROLE_DEFINITIONS.admin.permissions,
            ),
          },
        ],
      ]),
      auditEvents: [],
      userAdminMutations: 0,
      groupAdminMutations: 0,
    };

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 8,
    });
    const passwordHash = await passwordService.hashPassword("SecurityTest2026!");
    const sessionService = createSessionService({ store: createMemorySessionStore() });

    const credentials = new Map<string, AuthCredentialRecord>([
      [
        "scoped@org-a.invalid",
        {
          user: {
            id: userScopedId,
            organizationId: orgA,
            email: "scoped@org-a.invalid",
            fullName: "Usuário Escopo",
            status: "ACTIVE",
            createdAt: now,
            updatedAt: now,
          },
          passwordHash,
        },
      ],
      [
        "viewer@org-a.invalid",
        {
          user: {
            id: userViewerId,
            organizationId: orgA,
            email: "viewer@org-a.invalid",
            fullName: "Usuário Consulta",
            status: "ACTIVE",
            createdAt: now,
            updatedAt: now,
          },
          passwordHash,
        },
      ],
      [
        "admin@org-a.invalid",
        {
          user: {
            id: userGlobalAdminAId,
            organizationId: orgA,
            email: "admin@org-a.invalid",
            fullName: "Admin Org A",
            status: "ACTIVE",
            createdAt: now,
            updatedAt: now,
          },
          passwordHash,
        },
      ],
    ]);

    const userLookup: AuthUserLookupPort = {
      async findCredentialByEmail(email: string) {
        return credentials.get(email) ?? null;
      },
      async findProfileById(id: string) {
        for (const cred of credentials.values()) {
          if (cred.user.id === id) {
            return {
              user: cred.user,
              groups: [],
              roles: [],
              permissions: [],
            };
          }
        }
        return null;
      },
    };

    const repos = createInMemoryRepositories(state);
    const authService = createAuthService({
      users: userLookup,
      passwordService,
      sessionService,
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      authService,
      userAdminService: repos.userAdminService,
      groupAdminService: repos.groupAdminService,
      documentDeps: {
        authzRepository: repos.authzRepository,
        documentRepository: repos.documentRepository,
        auditRepository: repos.auditRepository,
      },
    });

    const loginAs = async (email: string): Promise<{ cookie: string; csrf: string }> => {
      const csrfRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
      });
      const csrf = csrfRes.json().data.csrfToken as string;
      const loginRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/auth/login`,
        cookies: { [CSRF_COOKIE_NAME]: csrf },
        headers: { [CSRF_HEADER_NAME]: csrf },
        payload: { email, password: "SecurityTest2026!" },
      });
      expect(loginRes.statusCode).toBe(200);
      const cookie = loginRes.cookies.find((c) => c.name === "papyrus_session")?.value ?? "";
      return { cookie, csrf };
    };

    const scopedSession = await loginAs("scoped@org-a.invalid");
    const viewerSession = await loginAs("viewer@org-a.invalid");
    const adminSession = await loginAs("admin@org-a.invalid");

    // 1. Unauthenticated requests fail closed with 401
    expect(
      (await app.inject({ method: "GET", url: `${CONTRACTS_API_PREFIX}/documents` })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedId}`,
        })
      ).statusCode,
    ).toBe(401);

    // 2. Listing and keyword search count MUST filter by permissions first (zero count leakage)
    const searchSecret = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents?search=Sigiloso`,
      cookies: { papyrus_session: scopedSession.cookie },
    });
    expect(searchSecret.statusCode).toBe(200);
    expect(searchSecret.json()).toEqual({
      items: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    });

    const listAllScoped = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents?page=1&pageSize=10`,
      cookies: { papyrus_session: scopedSession.cookie },
    });
    expect(listAllScoped.statusCode).toBe(200);
    expect(listAllScoped.json().items).toHaveLength(1);
    expect(listAllScoped.json().items[0]?.id).toBe(docAllowedId);
    expect(listAllScoped.json().pagination).toEqual({
      page: 1,
      pageSize: 10,
      totalItems: 1,
      totalPages: 1,
    });

    const filterDeniedFolder = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents?folderId=${folderChildDenied}`,
      cookies: { papyrus_session: scopedSession.cookie },
    });
    expect(filterDeniedFolder.statusCode).toBe(200);
    expect(filterDeniedFolder.json().pagination.totalItems).toBe(0);
    expect(filterDeniedFolder.json().items).toEqual([]);

    // 3. IDOR on GET /documents/:id returns uniform 403 for denied/cross-tenant/non-existent IDs (no oracle)
    const deniedBySubfolderRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${docDeniedGrandchildId}`,
      cookies: { papyrus_session: scopedSession.cookie },
    });
    const deniedByDocExceptionRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${docDeniedExplicitId}`,
      cookies: { papyrus_session: scopedSession.cookie },
    });
    const crossTenantRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${docOrgBId}`,
      cookies: { papyrus_session: scopedSession.cookie },
    });
    const nonExistentScopedRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${nonExistentDocId}`,
      cookies: { papyrus_session: scopedSession.cookie },
    });

    expect(deniedBySubfolderRes.statusCode).toBe(403);
    expect(deniedByDocExceptionRes.statusCode).toBe(403);
    expect(crossTenantRes.statusCode).toBe(403);
    expect(nonExistentScopedRes.statusCode).toBe(403);
    expect(deniedByDocExceptionRes.json().error.message).toBe(
      nonExistentScopedRes.json().error.message,
    );

    // Global admin of Org A still cannot read Org B's document (cross-tenant IDOR -> 404)
    const adminCrossTenantRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${docOrgBId}`,
      cookies: { papyrus_session: adminSession.cookie },
    });
    expect(adminCrossTenantRes.statusCode).toBe(404);

    // 4. IDOR on mutations (PATCH /POST): viewer cannot mutate docAllowedId, scoped user cannot tamper protected fields
    const viewerPatchRes = await app.inject({
      method: "PATCH",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedId}`,
      cookies: {
        papyrus_session: viewerSession.cookie,
        [CSRF_COOKIE_NAME]: viewerSession.csrf,
      },
      headers: { [CSRF_HEADER_NAME]: viewerSession.csrf },
      payload: { expectedVersion: 1, title: "Alterado Indevidamente" },
    });
    expect(viewerPatchRes.statusCode).toBe(403);
    expect(state.documents.get(docAllowedId)?.title).toBe("Manual Operacional Público");
    expect(state.documents.get(docAllowedId)?.version).toBe(1);

    // Attempting to inject protected ownership/status/storage fields on POST is ignored by schema and denied out of scope
    const createDeniedSubfolderRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents`,
      cookies: {
        papyrus_session: scopedSession.cookie,
        [CSRF_COOKIE_NAME]: scopedSession.csrf,
      },
      headers: { [CSRF_HEADER_NAME]: scopedSession.csrf },
      payload: {
        title: "Tentativa em Pasta Bloqueada",
        categoryId: catPublic,
        folderId: folderGrandchildDenied,
      },
    });
    expect(createDeniedSubfolderRes.statusCode).toBe(403);

    const createWithTamperedFieldsRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents`,
      cookies: {
        papyrus_session: scopedSession.cookie,
        [CSRF_COOKIE_NAME]: scopedSession.csrf,
      },
      headers: { [CSRF_HEADER_NAME]: scopedSession.csrf },
      payload: {
        title: "Documento com Campos Protegidos Ignorados",
        categoryId: catPublic,
        folderId: folderChildAllowed,
        status: "APPROVED",
        ownerUserId: userGlobalAdminAId,
        organizationId: orgB,
      },
    });
    expect(createWithTamperedFieldsRes.statusCode).toBe(201);
    const createdDoc = createWithTamperedFieldsRes.json().data as DocumentEntity;
    expect(createdDoc.status).toBe("DRAFT");
    expect(createdDoc.ownerUserId).toBe(userScopedId);
    expect(createdDoc.organizationId).toBe(orgA);

    await app.close();
  });

  it("blocks unauthorized preview, download, quarantine file reads, permission changes, and reflects immediate revocation", async () => {
    const orgId = "10000000-0000-4000-8000-000000000010";
    const categoryId = "20000000-0000-4000-8000-000000000010";
    const folderId = "30000000-0000-4000-8000-000000000010";
    const docId = "40000000-0000-4000-8000-000000000010";
    const previewOnlyUserId = "50000000-0000-4000-8000-000000000010";
    const collaboratorId = "50000000-0000-4000-8000-000000000011";
    const rolePreviewOnlyId = "60000000-0000-4000-8000-000000000010";
    const roleCollabId = "60000000-0000-4000-8000-000000000011";
    const targetGroupId = "70000000-0000-4000-8000-000000000010";
    const now = "2026-11-20T12:00:00.000Z";

    const collabAssignments: LoadedRoleAssignment[] = [
      {
        roleId: roleCollabId,
        roleKey: "collaborator",
        scope: { type: "FOLDER", folderId },
        effect: "ALLOW",
        source: "USER",
      },
    ];

    const state: TestHarnessState = {
      folders: new Map<string, FolderNode>([
        [folderId, { id: folderId, organizationId: orgId, parentId: null }],
      ]),
      documents: new Map<string, DocumentEntity>([
        [
          docId,
          {
            id: docId,
            organizationId: orgId,
            title: "Contrato Restrito",
            categoryId,
            folderId,
            status: "IN_REVIEW",
            currentVersionId: "80000000-0000-4000-8000-000000000010",
            ownerUserId: collaboratorId,
            issueDate: null,
            expirationDate: null,
            metadata: {},
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
      ]),
      subjects: new Map<string, LoadedAuthorizationSubject>([
        [
          `${orgId}:${previewOnlyUserId}`,
          {
            userId: previewOnlyUserId,
            organizationId: orgId,
            groupIds: [],
            assignments: [
              {
                roleId: rolePreviewOnlyId,
                roleKey: "preview_only",
                scope: { type: "DOCUMENT", documentId: docId },
                effect: "ALLOW",
                source: "USER",
              },
            ],
            rolePermissions: buildLoadedPermissions(rolePreviewOnlyId, "preview_only", [
              { action: "READ", resource: "DOCUMENT" },
            ]),
          },
        ],
        [
          `${orgId}:${collaboratorId}`,
          {
            userId: collaboratorId,
            organizationId: orgId,
            groupIds: [],
            assignments: collabAssignments,
            rolePermissions: buildLoadedPermissions(
              roleCollabId,
              "collaborator",
              SYSTEM_ROLE_DEFINITIONS.collaborator.permissions,
            ),
          },
        ],
      ]),
      auditEvents: [],
      userAdminMutations: 0,
      groupAdminMutations: 0,
    };

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 8,
    });
    const passwordHash = await passwordService.hashPassword("SecurityTest2026!");
    const sessionService = createSessionService({ store: createMemorySessionStore() });

    const credentials = new Map<string, AuthCredentialRecord>([
      [
        "preview@org.invalid",
        {
          user: {
            id: previewOnlyUserId,
            organizationId: orgId,
            email: "preview@org.invalid",
            fullName: "Preview Apenas",
            status: "ACTIVE",
            createdAt: now,
            updatedAt: now,
          },
          passwordHash,
        },
      ],
      [
        "colab@org.invalid",
        {
          user: {
            id: collaboratorId,
            organizationId: orgId,
            email: "colab@org.invalid",
            fullName: "Colaborador Comum",
            status: "ACTIVE",
            createdAt: now,
            updatedAt: now,
          },
          passwordHash,
        },
      ],
    ]);

    const userLookup: AuthUserLookupPort = {
      async findCredentialByEmail(email) {
        return credentials.get(email) ?? null;
      },
      async findProfileById(id) {
        for (const cred of credentials.values()) {
          if (cred.user.id === id) {
            return { user: cred.user, groups: [], roles: [], permissions: [] };
          }
        }
        return null;
      },
    };

    const repos = createInMemoryRepositories(state);
    const authService = createAuthService({
      users: userLookup,
      passwordService,
      sessionService,
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      authService,
      userAdminService: repos.userAdminService,
      groupAdminService: repos.groupAdminService,
      documentDeps: {
        authzRepository: repos.authzRepository,
        documentRepository: repos.documentRepository,
        auditRepository: repos.auditRepository,
      },
    });

    const csrfRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
    });
    const csrf = csrfRes.json().data.csrfToken as string;

    const previewLogin = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/auth/login`,
      cookies: { [CSRF_COOKIE_NAME]: csrf },
      headers: { [CSRF_HEADER_NAME]: csrf },
      payload: { email: "preview@org.invalid", password: "SecurityTest2026!" },
    });
    const previewCookie =
      previewLogin.cookies.find((c) => c.name === "papyrus_session")?.value ?? "";

    const collabLogin = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/auth/login`,
      cookies: { [CSRF_COOKIE_NAME]: csrf },
      headers: { [CSRF_HEADER_NAME]: csrf },
      payload: { email: "colab@org.invalid", password: "SecurityTest2026!" },
    });
    const collabCookie = collabLogin.cookies.find((c) => c.name === "papyrus_session")?.value ?? "";

    // 1. Preview vs Download permission separation & quarantine gate
    const previewDocGuardApp = Fastify({ logger: false });
    await previewDocGuardApp.register((await import("@fastify/cookie")).default);
    const guard = createDocumentAuthorizationGuard({
      authService,
      authzRepository: repos.authzRepository,
      documentRepository: repos.documentRepository,
    });
    let currentFileStatus: FileObjectStatus = "AVAILABLE";

    previewDocGuardApp.get<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/documents/:id/preview`,
      async (request, reply) => {
        const ctx = await guard.requireSubject(request, reply);
        if (!ctx) return reply;
        const doc = await guard.authorizeDocument(
          ctx,
          request.params.id,
          "READ",
          reply,
          request.id,
        );
        if (!doc) return reply;
        if (!isFileObjectDownloadable(currentFileStatus)) {
          return reply.status(409).send({ error: { code: "FILE_NOT_AVAILABLE" } });
        }
        return reply.status(200).send({ ok: true });
      },
    );
    previewDocGuardApp.post<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/documents/:id/download-target`,
      async (request, reply) => {
        const ctx = await guard.requireSubject(request, reply);
        if (!ctx) return reply;
        const doc = await guard.authorizeDocument(
          ctx,
          request.params.id,
          "DOWNLOAD",
          reply,
          request.id,
        );
        if (!doc) return reply;
        if (!isFileObjectDownloadable(currentFileStatus)) {
          return reply.status(409).send({ error: { code: "FILE_NOT_AVAILABLE" } });
        }
        return reply.status(200).send({ ok: true });
      },
    );
    previewDocGuardApp.patch<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/documents/:id/permissions`,
      async (request, reply) => {
        const ctx = await guard.requireSubject(request, reply);
        if (!ctx) return reply;
        const doc = await guard.authorizeDocument(
          ctx,
          request.params.id,
          "MANAGE_PERMISSIONS",
          reply,
          request.id,
        );
        if (!doc) return reply;
        return reply.status(200).send({ ok: true });
      },
    );

    // Preview-only user CAN preview (READ), CANNOT download (DOWNLOAD -> 403), CANNOT change permissions (MANAGE_PERMISSIONS -> 403)
    expect(
      (
        await previewDocGuardApp.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/documents/${docId}/preview`,
          cookies: { papyrus_session: previewCookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await previewDocGuardApp.inject({
          method: "POST",
          url: `${CONTRACTS_API_PREFIX}/documents/${docId}/download-target`,
          cookies: { papyrus_session: previewCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await previewDocGuardApp.inject({
          method: "PATCH",
          url: `${CONTRACTS_API_PREFIX}/documents/${docId}/permissions`,
          cookies: { papyrus_session: previewCookie },
        })
      ).statusCode,
    ).toBe(403);

    // Quarantined/rejected binaries never release preview or download even when authorized
    for (const blockedStatus of [
      "UPLOADING",
      "QUARANTINED",
      "REJECTED",
      "MISSING",
      "DELETE_PENDING",
    ] satisfies FileObjectStatus[]) {
      currentFileStatus = blockedStatus;
      expect(isFileObjectDownloadable(blockedStatus)).toBe(false);
      expect(
        (
          await previewDocGuardApp.inject({
            method: "POST",
            url: `${CONTRACTS_API_PREFIX}/documents/${docId}/download-target`,
            cookies: { papyrus_session: collabCookie },
          })
        ).statusCode,
      ).toBe(409);
    }
    currentFileStatus = "AVAILABLE";

    // 2. Collaborator cannot escalate privileges via admin user/group endpoints or document MANAGE_PERMISSIONS
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${CONTRACTS_API_PREFIX}/admin/users`,
          cookies: { papyrus_session: collabCookie, [CSRF_COOKIE_NAME]: csrf },
          headers: { [CSRF_HEADER_NAME]: csrf },
          payload: {
            email: "escalated@org.invalid",
            fullName: "Escalonado",
            password: "StrongPassword2026!",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${CONTRACTS_API_PREFIX}/admin/groups/${targetGroupId}/members`,
          cookies: { papyrus_session: collabCookie, [CSRF_COOKIE_NAME]: csrf },
          headers: { [CSRF_HEADER_NAME]: csrf },
          payload: { userId: collaboratorId },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await previewDocGuardApp.inject({
          method: "PATCH",
          url: `${CONTRACTS_API_PREFIX}/documents/${docId}/permissions`,
          cookies: { papyrus_session: collabCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(state.userAdminMutations).toBe(0);
    expect(state.groupAdminMutations).toBe(0);

    // Domain evaluation also denies MANAGE_PERMISSIONS for non-managers
    const loadedCollab = await repos.authzRepository.loadSubject(orgId, collaboratorId);
    const managePermDecision = evaluateDocumentAuthorization(
      toSubjectContext(loadedCollab),
      "MANAGE_PERMISSIONS",
      { documentId: docId, categoryId, folderAncestorIds: [folderId] },
      buildRolePermissionsLookup(loadedCollab),
    );
    expect(managePermDecision.allowed).toBe(false);

    // 3. Permission change (adding explicit DENY) revokes access immediately without stale cache leakage
    collabAssignments.push({
      roleId: roleCollabId,
      roleKey: "collaborator",
      scope: { type: "DOCUMENT", documentId: docId },
      effect: "DENY",
      source: "USER",
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/documents/${docId}`,
          cookies: { papyrus_session: collabCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await previewDocGuardApp.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/documents/${docId}/preview`,
          cookies: { papyrus_session: collabCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await previewDocGuardApp.inject({
          method: "POST",
          url: `${CONTRACTS_API_PREFIX}/documents/${docId}/download-target`,
          cookies: { papyrus_session: collabCookie },
        })
      ).statusCode,
    ).toBe(403);

    const listAfterRevocation = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents`,
      cookies: { papyrus_session: collabCookie },
    });
    expect(listAfterRevocation.statusCode).toBe(200);
    expect(listAfterRevocation.json().pagination.totalItems).toBe(0);
    expect(listAfterRevocation.json().items).toEqual([]);

    await previewDocGuardApp.close();
    await app.close();
  });
});
