import { describe, expect, it } from "vitest";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditRepositoryPort,
} from "../ports/audit-repository.port.js";
import type { PaginatedResult } from "../ports/document-repository.port.js";
import type {
  ArchiveFolderInput,
  CreateFolderInput,
  FolderRepositoryPort,
  MoveFolderSubtreeInput,
  RenameFolderInput,
} from "../ports/folder-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import {
  buildFolderMaterializedPath,
  createFolderService,
  isFolderHierarchyCycle,
} from "./folder-service.js";
import type { AuthorizedFolderQueryScope, FolderEntity, FolderListFilter } from "./folder.types.js";

function createInMemoryHarness() {
  const store = new Map<string, FolderEntity>();
  const auditEvents: AuditEventRecord[] = [];
  let seq = 0;

  const folders: FolderRepositoryPort = {
    async findById(id: string): Promise<FolderEntity | null> {
      return store.get(id) ?? null;
    },
    async findByNameInParent(
      organizationId: string,
      parentId: string | null,
      name: string,
    ): Promise<FolderEntity | null> {
      for (const item of store.values()) {
        if (
          item.organizationId === organizationId &&
          item.parentId === parentId &&
          item.name === name
        ) {
          return item;
        }
      }
      return null;
    },
    async listAncestorIds(organizationId: string, folderId: string): Promise<readonly string[]> {
      const ancestors: string[] = [];
      const visited = new Set<string>([folderId]);
      let current = store.get(folderId);
      while (current && current.organizationId === organizationId && current.parentId !== null) {
        if (visited.has(current.parentId)) {
          break;
        }
        visited.add(current.parentId);
        ancestors.push(current.parentId);
        current = store.get(current.parentId);
      }
      return ancestors;
    },
    async hasActiveChildren(organizationId: string, folderId: string): Promise<boolean> {
      for (const item of store.values()) {
        if (
          item.organizationId === organizationId &&
          item.parentId === folderId &&
          item.status === "ACTIVE"
        ) {
          return true;
        }
      }
      return false;
    },
    async listAuthorized(
      filter: FolderListFilter,
      _scope: AuthorizedFolderQueryScope,
    ): Promise<PaginatedResult<FolderEntity>> {
      const items = [...store.values()].filter(
        (item) => item.organizationId === filter.organizationId,
      );
      return {
        items,
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: items.length,
        totalPages: items.length === 0 ? 0 : 1,
      };
    },
    async create(input: CreateFolderInput): Promise<FolderEntity> {
      const now = new Date().toISOString();
      const entity: FolderEntity = {
        id: input.id,
        organizationId: input.organizationId,
        parentId: input.parentId,
        name: input.name,
        materializedPath: input.materializedPath,
        status: "ACTIVE",
        createdAt: now,
        updatedAt: now,
      };
      store.set(entity.id, entity);
      return entity;
    },
    async rename(input: RenameFolderInput): Promise<FolderEntity | null> {
      const existing = store.get(input.id);
      if (!existing || existing.organizationId !== input.organizationId) {
        return null;
      }
      const updated: FolderEntity = {
        ...existing,
        name: input.name,
        updatedAt: new Date().toISOString(),
      };
      store.set(updated.id, updated);
      return updated;
    },
    async moveSubtree(input: MoveFolderSubtreeInput): Promise<FolderEntity | null> {
      const target = store.get(input.folderId);
      if (!target || target.organizationId !== input.organizationId) {
        return null;
      }
      const descendantPrefix = `${input.oldMaterializedPath}/`;
      for (const item of store.values()) {
        if (item.organizationId !== input.organizationId) {
          continue;
        }
        if (item.id === input.folderId) {
          store.set(item.id, {
            ...item,
            parentId: input.newParentId,
            materializedPath: input.newMaterializedPath,
            updatedAt: new Date().toISOString(),
          });
        } else if (item.materializedPath.startsWith(descendantPrefix)) {
          const suffix = item.materializedPath.slice(input.oldMaterializedPath.length);
          store.set(item.id, {
            ...item,
            materializedPath: `${input.newMaterializedPath}${suffix}`,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return store.get(input.folderId) ?? null;
    },
    async archive(input: ArchiveFolderInput): Promise<FolderEntity | null> {
      const existing = store.get(input.id);
      if (!existing || existing.organizationId !== input.organizationId) {
        return null;
      }
      const updated: FolderEntity = {
        ...existing,
        status: "ARCHIVED",
        updatedAt: new Date().toISOString(),
      };
      store.set(updated.id, updated);
      return updated;
    },
  };

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({} as TransactionContext);
    },
  };

  const audit: AuditRepositoryPort = {
    async append(event: AuditEventInput): Promise<AuditEventRecord> {
      const record: AuditEventRecord = {
        ...event,
        id: `audit-${auditEvents.length + 1}`,
        occurredAt: new Date().toISOString(),
      };
      auditEvents.push(record);
      return record;
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  const service = createFolderService({
    folders,
    transactions,
    audit,
    generateId: () => `folder-${++seq}`,
  });

  return { service, store, auditEvents };
}

describe("FolderService", () => {
  it("builds materialized paths and prevents hierarchy cycles", () => {
    expect(buildFolderMaterializedPath("a", null)).toBe("/a");
    expect(buildFolderMaterializedPath("b", "/a")).toBe("/a/b");

    expect(
      isFolderHierarchyCycle(
        { id: "a", materializedPath: "/a" },
        { id: "b", materializedPath: "/a/b" },
        ["a"],
      ),
    ).toBe(true);

    expect(
      isFolderHierarchyCycle(
        { id: "a", materializedPath: "/a" },
        { id: "c", materializedPath: "/c" },
        [],
      ),
    ).toBe(false);
  });

  it("creates, renames, moves subtree while updating paths, rejects cycles, and archives leaf folders", async () => {
    const { service, store, auditEvents } = createInMemoryHarness();
    const orgId = "org-1";
    const userId = "user-1";

    const root = await service.createFolder({
      organizationId: orgId,
      actorUserId: userId,
      requestId: "req-1",
      parentId: null,
      name: "  Financeiro  ",
    });
    expect(root.materializedPath).toBe(`/${root.id}`);
    expect(root.name).toBe("Financeiro");

    const child = await service.createFolder({
      organizationId: orgId,
      actorUserId: userId,
      requestId: "req-2",
      parentId: root.id,
      name: "Contratos",
    });
    const grandChild = await service.createFolder({
      organizationId: orgId,
      actorUserId: userId,
      requestId: "req-3",
      parentId: child.id,
      name: "2026",
    });
    expect(grandChild.materializedPath).toBe(`/${root.id}/${child.id}/${grandChild.id}`);

    const otherRoot = await service.createFolder({
      organizationId: orgId,
      actorUserId: userId,
      requestId: "req-4",
      parentId: null,
      name: "Jurídico",
    });

    await expect(
      service.moveFolder({
        organizationId: orgId,
        actorUserId: userId,
        requestId: "req-5",
        folderId: root.id,
        targetParentId: grandChild.id,
      }),
    ).rejects.toMatchObject({ code: "FOLDER_HIERARCHY_CYCLE" });

    const movedChild = await service.moveFolder({
      organizationId: orgId,
      actorUserId: userId,
      requestId: "req-6",
      folderId: child.id,
      targetParentId: otherRoot.id,
    });
    expect(movedChild.materializedPath).toBe(`/${otherRoot.id}/${child.id}`);
    expect(store.get(grandChild.id)?.materializedPath).toBe(
      `/${otherRoot.id}/${child.id}/${grandChild.id}`,
    );

    const renamed = await service.renameFolder({
      organizationId: orgId,
      actorUserId: userId,
      requestId: "req-7",
      folderId: grandChild.id,
      name: "2026-Vigente",
    });
    expect(renamed.name).toBe("2026-Vigente");

    await expect(
      service.archiveFolder({
        organizationId: orgId,
        actorUserId: userId,
        requestId: "req-8",
        folderId: child.id,
      }),
    ).rejects.toMatchObject({ code: "FOLDER_HAS_ACTIVE_CHILDREN" });

    const archivedGrandChild = await service.archiveFolder({
      organizationId: orgId,
      actorUserId: userId,
      requestId: "req-9",
      folderId: grandChild.id,
    });
    expect(archivedGrandChild.status).toBe("ARCHIVED");
    expect(auditEvents.map((e) => e.action)).toContain("FOLDER_MOVED");
    expect(auditEvents.map((e) => e.action)).toContain("FOLDER_ARCHIVED");
  });
});
