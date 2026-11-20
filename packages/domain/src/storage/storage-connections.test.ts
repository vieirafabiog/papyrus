import { describe, expect, it } from "vitest";
import {
  type AuditEventInput,
  type AuditEventRecord,
  type AuditListFilter,
  type AuditRepositoryPort,
  type CreateStorageConnectionInput,
  DomainError,
  type StorageConnectionEntity,
  type StorageConnectionHealthOutput,
  type StorageConnectionRepositoryPort,
  type TransactionContext,
  type TransactionManagerPort,
  type UpdateStorageConnectionInput,
  createStorageConnectionAdminService,
} from "../index.js";

function createTestHarness(
  options: {
    linkedConnectionIds?: readonly string[];
    healthResponse?: StorageConnectionHealthOutput;
    throwOnHealthCheck?: boolean;
  } = {},
) {
  const store = new Map<string, StorageConnectionEntity>();
  const auditEvents: AuditEventRecord[] = [];
  const linked = new Set(options.linkedConnectionIds ?? []);
  let nextSeq = 1;

  const connections: StorageConnectionRepositoryPort = {
    async findById(id: string) {
      return store.get(id) ?? null;
    },
    async findDefaultByOrganization(organizationId: string) {
      for (const item of store.values()) {
        if (item.organizationId === organizationId && item.isDefault) {
          return item;
        }
      }
      return null;
    },
    async listByOrganization(organizationId: string) {
      return Array.from(store.values()).filter((item) => item.organizationId === organizationId);
    },
    async create(input: CreateStorageConnectionInput) {
      const now = "2026-11-20T15:00:00.000Z";
      const entity: StorageConnectionEntity = {
        id: input.id,
        organizationId: input.organizationId,
        name: input.name,
        kind: input.kind,
        isDefault: input.isDefault,
        status: "ACTIVE",
        nonSecretConfig: input.nonSecretConfig,
        encryptedSecretRef: input.encryptedSecretRef,
        lastHealthCheckAt: null,
        lastHealthMessage: null,
        createdAt: now,
        updatedAt: now,
      };
      store.set(entity.id, entity);
      return entity;
    },
    async update(id: string, input: UpdateStorageConnectionInput) {
      const existing = store.get(id);
      if (!existing) {
        return null;
      }
      const updated: StorageConnectionEntity = {
        ...existing,
        name: input.name ?? existing.name,
        isDefault: input.isDefault ?? existing.isDefault,
        status: input.status ?? existing.status,
        nonSecretConfig: input.nonSecretConfig ?? existing.nonSecretConfig,
        encryptedSecretRef:
          input.encryptedSecretRef !== undefined
            ? input.encryptedSecretRef
            : existing.encryptedSecretRef,
        lastHealthCheckAt:
          input.lastHealthCheckAt !== undefined
            ? input.lastHealthCheckAt
            : existing.lastHealthCheckAt,
        lastHealthMessage:
          input.lastHealthMessage !== undefined
            ? input.lastHealthMessage
            : existing.lastHealthMessage,
        updatedAt: "2026-11-20T15:05:00.000Z",
      };
      store.set(id, updated);
      return updated;
    },
    async hasLinkedFileObjects(connectionId: string) {
      return linked.has(connectionId);
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
        occurredAt: "2026-11-20T15:00:00.000Z",
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

  const service = createStorageConnectionAdminService({
    connections,
    transactions,
    audit,
    secretEncryptor: {
      encrypt(credentials) {
        return `dfvault:v1:encrypted(${Object.keys(credentials).join(",")})`;
      },
    },
    healthTester: {
      async testConnection() {
        if (options.throwOnHealthCheck) {
          throw new Error("Simulated secret leak AKIA123");
        }
        return (
          options.healthResponse ?? {
            healthy: true,
            message: "Armazenamento operacional.",
            checkedAt: new Date("2026-11-20T15:10:00.000Z"),
          }
        );
      },
    },
    generateId: () => `conn-${nextSeq++}`,
    now: () => new Date("2026-11-20T15:10:00.000Z"),
  });

  return { service, store, auditEvents, linked };
}

describe("StorageConnectionAdminService", () => {
  it("creates, edits, swaps default connection, and conceals encrypted secret payloads", async () => {
    const { service, store, auditEvents } = createTestHarness();

    const localConn = await service.createConnection({
      organizationId: "org-1",
      actorUserId: "admin-1",
      requestId: "req-1",
      name: "Filesystem Local",
      kind: "local",
      isDefault: true,
      nonSecretConfig: { rootDirectory: "/var/lib/docuflow/storage" },
    });

    expect(localConn.isDefault).toBe(true);
    expect(localConn.hasCredentials).toBe(false);

    // Duplicate name rejected
    await expect(
      service.createConnection({
        organizationId: "org-1",
        actorUserId: "admin-1",
        requestId: "req-2",
        name: "  filesystem local ",
        kind: "local",
        nonSecretConfig: { rootDirectory: "/tmp/other" },
      }),
    ).rejects.toMatchObject({ code: "STORAGE_CONNECTION_NAME_IN_USE" });

    const s3Conn = await service.createConnection({
      organizationId: "org-1",
      actorUserId: "admin-1",
      requestId: "req-3",
      name: "MinIO Principal",
      kind: "s3",
      isDefault: true,
      nonSecretConfig: { bucket: "docuflow", region: "us-east-1" },
      credentials: { accessKeyId: "AKIA", secretAccessKey: "SECRET" },
    });

    expect(s3Conn.isDefault).toBe(true);
    expect(s3Conn.hasCredentials).toBe(true);
    expect("encryptedSecretRef" in s3Conn).toBe(false);
    expect(store.get(s3Conn.id)?.encryptedSecretRef).toContain("dfvault:v1");
    // Previous default was cleared automatically
    expect(store.get(localConn.id)?.isDefault).toBe(false);

    const renamed = await service.updateConnection({
      organizationId: "org-1",
      actorUserId: "admin-1",
      requestId: "req-4",
      connectionId: localConn.id,
      name: "Filesystem Primário",
    });
    expect(renamed.name).toBe("Filesystem Primário");
    expect(auditEvents.map((e) => e.action)).toEqual([
      "STORAGE_CONNECTION_CREATED",
      "STORAGE_CONNECTION_CREATED",
      "STORAGE_CONNECTION_UPDATED",
    ]);
  });

  it("blocks deactivation when connection is default or still needed to read existing file objects", async () => {
    const { service, linked } = createTestHarness();

    const conn1 = await service.createConnection({
      organizationId: "org-1",
      actorUserId: "admin-1",
      requestId: "req-1",
      name: "Storage 1",
      kind: "local",
      isDefault: true,
      nonSecretConfig: { rootDirectory: "/data/s1" },
    });
    const conn2 = await service.createConnection({
      organizationId: "org-1",
      actorUserId: "admin-1",
      requestId: "req-2",
      name: "Storage 2",
      kind: "local",
      isDefault: false,
      nonSecretConfig: { rootDirectory: "/data/s2" },
    });

    // Cannot deactivate default connection
    await expect(
      service.deactivateConnection({
        organizationId: "org-1",
        actorUserId: "admin-1",
        requestId: "req-3",
        connectionId: conn1.id,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_CONNECTION_IS_DEFAULT" });

    // Switch default to conn2, but link an existing file object to conn1
    await service.setDefaultConnection({
      organizationId: "org-1",
      actorUserId: "admin-1",
      requestId: "req-4",
      connectionId: conn2.id,
    });
    linked.add(conn1.id);

    // Must still block deactivation because existing file objects depend on conn1
    await expect(
      service.deactivateConnection({
        organizationId: "org-1",
        actorUserId: "admin-1",
        requestId: "req-5",
        connectionId: conn1.id,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_CONNECTION_IN_USE" });

    // Once no file objects depend on conn1, deactivation and reactivation succeed
    linked.delete(conn1.id);
    const deactivated = await service.deactivateConnection({
      organizationId: "org-1",
      actorUserId: "admin-1",
      requestId: "req-6",
      connectionId: conn1.id,
    });
    expect(deactivated.status).toBe("INACTIVE");

    // Inactive connection cannot be set as default
    await expect(
      service.setDefaultConnection({
        organizationId: "org-1",
        actorUserId: "admin-1",
        requestId: "req-7",
        connectionId: conn1.id,
      }),
    ).rejects.toBeInstanceOf(DomainError);

    const reactivated = await service.activateConnection({
      organizationId: "org-1",
      actorUserId: "admin-1",
      requestId: "req-8",
      connectionId: conn1.id,
    });
    expect(reactivated.status).toBe("ACTIVE");
  });

  it("tests connection health, updates status safely on failure without leaking secrets, and records audit", async () => {
    const { service, auditEvents } = createTestHarness({ throwOnHealthCheck: true });

    const conn = await service.createConnection({
      organizationId: "org-1",
      actorUserId: "admin-1",
      requestId: "req-1",
      name: "Local Test",
      kind: "local",
      nonSecretConfig: { rootDirectory: "/data/test" },
    });

    const testResult = await service.testConnection({
      organizationId: "org-1",
      actorUserId: "admin-1",
      requestId: "req-2",
      connectionId: conn.id,
    });

    expect(testResult.health.healthy).toBe(false);
    expect(testResult.health.message).not.toContain("AKIA123");
    expect(testResult.connection.status).toBe("ERROR");
    expect(testResult.connection.lastHealthMessage).toBe(testResult.health.message);
    expect(auditEvents[auditEvents.length - 1]?.action).toBe("STORAGE_CONNECTION_TESTED");
    expect(auditEvents[auditEvents.length - 1]?.result).toBe("FAILURE");
  });
});
