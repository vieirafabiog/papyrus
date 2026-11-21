import { describe, expect, it } from "vitest";
import {
  type AuditEventInput,
  type AuditEventRecord,
  type AuditListFilter,
  type AuditRepositoryPort,
  DomainError,
  type FileObjectEntity,
  type StorageConnectionEntity,
  type StorageConnectionRepositoryPort,
  type StorageRoutingRuleEntity,
  type StorageRoutingRuleRepositoryPort,
  type TransactionContext,
  type TransactionManagerPort,
  type UpsertStorageRoutingRuleInput,
  bindFileObjectToStorageTarget,
  createStorageRouterService,
} from "../index.js";

function makeConnection(
  id: string,
  organizationId: string,
  kind: "local" | "s3",
  options: { isDefault?: boolean; status?: "ACTIVE" | "INACTIVE" | "ERROR" } = {},
): StorageConnectionEntity {
  const now = "2026-11-21T08:00:00.000Z";
  return {
    id,
    organizationId,
    name: `Conn ${id}`,
    kind,
    isDefault: options.isDefault ?? false,
    status: options.status ?? "ACTIVE",
    nonSecretConfig: {},
    encryptedSecretRef: null,
    lastHealthCheckAt: null,
    lastHealthMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createRouterHarness() {
  const connectionsMap = new Map<string, StorageConnectionEntity>();
  const rulesMap = new Map<string, StorageRoutingRuleEntity>();
  const fileObjectsMap = new Map<string, FileObjectEntity>();
  const auditEvents: AuditEventRecord[] = [];
  let seq = 1;

  const connections: StorageConnectionRepositoryPort = {
    async findById(id) {
      return connectionsMap.get(id) ?? null;
    },
    async findDefaultByOrganization(organizationId) {
      for (const item of connectionsMap.values()) {
        if (item.organizationId === organizationId && item.isDefault) {
          return item;
        }
      }
      return null;
    },
    async listByOrganization(organizationId) {
      return Array.from(connectionsMap.values()).filter(
        (item) => item.organizationId === organizationId,
      );
    },
    async create(input) {
      const entity = makeConnection(input.id, input.organizationId, input.kind as "local" | "s3", {
        isDefault: input.isDefault,
      });
      connectionsMap.set(entity.id, entity);
      return entity;
    },
    async update(id, input) {
      const existing = connectionsMap.get(id);
      if (!existing) {
        return null;
      }
      const updated: StorageConnectionEntity = {
        ...existing,
        isDefault: input.isDefault ?? existing.isDefault,
        status: input.status ?? existing.status,
      };
      connectionsMap.set(id, updated);
      return updated;
    },
    async hasLinkedFileObjects(connectionId) {
      for (const obj of fileObjectsMap.values()) {
        if (obj.storageConnectionId === connectionId) {
          return true;
        }
      }
      return false;
    },
  };

  const ruleKey = (organizationId: string, categoryId: string | null): string =>
    `${organizationId}::${categoryId ?? "__INSTALLATION_DEFAULT__"}`;

  const routingRules: StorageRoutingRuleRepositoryPort = {
    async findByOrganizationAndCategory(organizationId, categoryId) {
      return rulesMap.get(ruleKey(organizationId, categoryId)) ?? null;
    },
    async listByOrganization(organizationId) {
      return Array.from(rulesMap.values()).filter((rule) => rule.organizationId === organizationId);
    },
    async upsertRule(input: UpsertStorageRoutingRuleInput) {
      const key = ruleKey(input.organizationId, input.categoryId);
      const existing = rulesMap.get(key);
      const now = "2026-11-21T08:05:00.000Z";
      const entity: StorageRoutingRuleEntity = {
        id: existing?.id ?? input.id,
        organizationId: input.organizationId,
        categoryId: input.categoryId,
        storageConnectionId: input.storageConnectionId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      rulesMap.set(key, entity);
      return entity;
    },
    async deleteCategoryRule(organizationId, categoryId) {
      return rulesMap.delete(ruleKey(organizationId, categoryId));
    },
  };

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return work({ __brand: "TransactionContext" });
    },
  };

  const audit: AuditRepositoryPort = {
    async append(input: AuditEventInput) {
      const rec: AuditEventRecord = {
        ...input,
        id: `audit-${auditEvents.length + 1}`,
        occurredAt: "2026-11-21T08:05:00.000Z",
      };
      auditEvents.push(rec);
      return rec;
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

  const router = createStorageRouterService({
    connections,
    routingRules,
    transactions,
    audit,
    generateId: () => `rule-${seq++}`,
  });

  return { router, connectionsMap, rulesMap, fileObjectsMap, auditEvents };
}

describe("StorageRouterService installation and category routing", () => {
  it("resolves organization default, installation rule, and category override, persisting connection on each object", async () => {
    const orgId = "org-1";
    const catContracts = "cat-contracts";
    const catInvoices = "cat-invoices";
    const { router, connectionsMap, fileObjectsMap } = createRouterHarness();

    const localDefault = makeConnection("conn-local", orgId, "local", { isDefault: true });
    const s3Primary = makeConnection("conn-s3-primary", orgId, "s3");
    const s3Archive = makeConnection("conn-s3-archive", orgId, "s3");
    connectionsMap.set(localDefault.id, localDefault);
    connectionsMap.set(s3Primary.id, s3Primary);
    connectionsMap.set(s3Archive.id, s3Archive);

    // 1. Falls back to organization default when no routing rules exist
    const fallbackTarget = await router.resolveWriteTarget({
      organizationId: orgId,
      categoryId: catInvoices,
    });
    expect(fallbackTarget.source).toBe("ORGANIZATION_DEFAULT");
    expect(fallbackTarget.connection.id).toBe(localDefault.id);

    // 2. Setting installation default rule overrides organization default
    await router.setRoutingRule({
      organizationId: orgId,
      actorUserId: "admin-1",
      requestId: "req-1",
      categoryId: null,
      storageConnectionId: s3Primary.id,
    });

    const installRuleTarget = await router.resolveWriteTarget({
      organizationId: orgId,
      categoryId: catInvoices,
    });
    expect(installRuleTarget.source).toBe("INSTALLATION_RULE");
    expect(installRuleTarget.connection.id).toBe(s3Primary.id);

    // 3. Category override routes matching category to s3Archive
    await router.setRoutingRule({
      organizationId: orgId,
      actorUserId: "admin-1",
      requestId: "req-2",
      categoryId: catContracts,
      storageConnectionId: s3Archive.id,
    });

    const contractTarget = await router.resolveWriteTarget({
      organizationId: orgId,
      categoryId: catContracts,
    });
    expect(contractTarget.source).toBe("CATEGORY_RULE");
    expect(contractTarget.connection.id).toBe(s3Archive.id);

    // Persist resolved connection directly on new FileObjectEntity
    const existingContractObj = bindFileObjectToStorageTarget({
      id: "file-obj-1",
      resolvedTarget: contractTarget,
      objectKey: "org/org-1/documents/d1/versions/1/file-obj-1",
      originalFileName: "contrato.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: "a".repeat(64),
    });
    fileObjectsMap.set(existingContractObj.id, existingContractObj);
    expect(existingContractObj.storageConnectionId).toBe(s3Archive.id);

    // 4. Changing category rule or clearing it NEVER moves existing objects and reads still use persisted connection
    await router.setRoutingRule({
      organizationId: orgId,
      actorUserId: "admin-1",
      requestId: "req-3",
      categoryId: catContracts,
      storageConnectionId: localDefault.id,
    });

    const nextContractTarget = await router.resolveWriteTarget({
      organizationId: orgId,
      categoryId: catContracts,
    });
    expect(nextContractTarget.connection.id).toBe(localDefault.id);

    // Existing object still retains original connection ID and reads from s3Archive!
    expect(existingContractObj.storageConnectionId).toBe(s3Archive.id);
    const readExisting = await router.resolveReadTarget({
      organizationId: orgId,
      storageConnectionId: existingContractObj.storageConnectionId,
    });
    expect(readExisting.source).toBe("PERSISTED_OBJECT");
    expect(readExisting.connection.id).toBe(s3Archive.id);

    // Clearing category rule falls back to installation rule for future objects
    expect(
      await router.clearCategoryRule({
        organizationId: orgId,
        actorUserId: "admin-1",
        requestId: "req-4",
        categoryId: catContracts,
      }),
    ).toBe(true);
    const afterClear = await router.resolveWriteTarget({
      organizationId: orgId,
      categoryId: catContracts,
    });
    expect(afterClear.source).toBe("INSTALLATION_RULE");
    expect(afterClear.connection.id).toBe(s3Primary.id);
  });

  it("rejects inactive destinations, cross-organization rules, and missing defaults safely", async () => {
    const { router, connectionsMap } = createRouterHarness();

    await expect(router.resolveWriteTarget({ organizationId: "org-1" })).rejects.toMatchObject({
      code: "STORAGE_CONNECTION_NOT_FOUND",
    });

    const inactive = makeConnection("conn-inactive", "org-1", "s3", { status: "INACTIVE" });
    const otherOrgConn = makeConnection("conn-other-org", "org-2", "local", { isDefault: true });
    connectionsMap.set(inactive.id, inactive);
    connectionsMap.set(otherOrgConn.id, otherOrgConn);

    // Cannot create routing rule targeting inactive connection
    await expect(
      router.setRoutingRule({
        organizationId: "org-1",
        actorUserId: "admin-1",
        requestId: "req-1",
        categoryId: "cat-1",
        storageConnectionId: inactive.id,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_CONNECTION_INACTIVE" });

    // Cross-organization connection is never resolvable
    await expect(
      router.setRoutingRule({
        organizationId: "org-1",
        actorUserId: "admin-1",
        requestId: "req-2",
        categoryId: "cat-1",
        storageConnectionId: otherOrgConn.id,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_CONNECTION_NOT_FOUND" });

    await expect(
      router.resolveReadTarget({
        organizationId: "org-1",
        storageConnectionId: otherOrgConn.id,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
