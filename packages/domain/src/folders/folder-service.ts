import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { PaginatedResult } from "../ports/document-repository.port.js";
import type { FolderRepositoryPort } from "../ports/folder-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import type { AuthorizedFolderQueryScope, FolderEntity, FolderListFilter } from "./folder.types.js";

export const MAX_FOLDER_NAME_LENGTH = 120;

export interface FolderServiceDependencies {
  readonly folders: FolderRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
}

export interface CreateFolderCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly parentId: string | null;
  readonly name: string;
}

export interface RenameFolderCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly folderId: string;
  readonly name: string;
}

export interface MoveFolderCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly folderId: string;
  readonly targetParentId: string | null;
}

export interface ArchiveFolderCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly folderId: string;
}

export interface FolderService {
  listAuthorizedFolders(
    filter: FolderListFilter,
    scope: AuthorizedFolderQueryScope,
  ): Promise<PaginatedResult<FolderEntity>>;
  getFolderById(organizationId: string, folderId: string): Promise<FolderEntity>;
  createFolder(command: CreateFolderCommand): Promise<FolderEntity>;
  renameFolder(command: RenameFolderCommand): Promise<FolderEntity>;
  moveFolder(command: MoveFolderCommand): Promise<FolderEntity>;
  archiveFolder(command: ArchiveFolderCommand): Promise<FolderEntity>;
}

/**
 * Normalizes and validates a folder name against domain constraints.
 */
export function normalizeFolderName(rawName: string): string {
  const normalized = rawName.trim();
  if (normalized.length === 0) {
    throw new DomainError("INVALID_FOLDER_NAME", "O nome da pasta é obrigatório.");
  }
  if (normalized.length > MAX_FOLDER_NAME_LENGTH) {
    throw new DomainError(
      "INVALID_FOLDER_NAME",
      `O nome da pasta deve ter no máximo ${MAX_FOLDER_NAME_LENGTH} caracteres.`,
    );
  }
  return normalized;
}

/**
 * Builds the canonical materialized path for a folder inside its organization tree.
 */
export function buildFolderMaterializedPath(folderId: string, parentPath: string | null): string {
  return parentPath === null ? `/${folderId}` : `${parentPath}/${folderId}`;
}

/**
 * Detects whether moving `folder` under `targetParent` would introduce a hierarchy cycle.
 */
export function isFolderHierarchyCycle(
  folder: Pick<FolderEntity, "id" | "materializedPath">,
  targetParent: Pick<FolderEntity, "id" | "materializedPath">,
  targetAncestorIds: readonly string[] = [],
): boolean {
  if (targetParent.id === folder.id) {
    return true;
  }
  if (
    targetParent.materializedPath === folder.materializedPath ||
    targetParent.materializedPath.startsWith(`${folder.materializedPath}/`)
  ) {
    return true;
  }
  return targetAncestorIds.includes(folder.id);
}

async function requireActiveFolderInOrganization(
  folders: FolderRepositoryPort,
  organizationId: string,
  folderId: string,
  notFoundMessage: string,
  tx: TransactionContext,
): Promise<FolderEntity> {
  const folder = await folders.findById(folderId, tx);
  if (!folder || folder.organizationId !== organizationId) {
    throw new DomainError("FOLDER_NOT_FOUND", notFoundMessage);
  }
  return folder;
}

/**
 * Creates the domain service responsible for hierarchical folder CRUD and invariants.
 */
export function createFolderService(deps: FolderServiceDependencies): FolderService {
  return {
    async listAuthorizedFolders(
      filter: FolderListFilter,
      scope: AuthorizedFolderQueryScope,
    ): Promise<PaginatedResult<FolderEntity>> {
      return deps.folders.listAuthorized(filter, scope);
    },

    async getFolderById(organizationId: string, folderId: string): Promise<FolderEntity> {
      const folder = await deps.folders.findById(folderId);
      if (!folder || folder.organizationId !== organizationId) {
        throw new DomainError("FOLDER_NOT_FOUND", "Pasta não encontrada.");
      }
      return folder;
    },

    async createFolder(command: CreateFolderCommand): Promise<FolderEntity> {
      const normalizedName = normalizeFolderName(command.name);

      return deps.transactions.runInTransaction(async (tx) => {
        let parentPath: string | null = null;
        if (command.parentId !== null) {
          const parent = await requireActiveFolderInOrganization(
            deps.folders,
            command.organizationId,
            command.parentId,
            "Pasta pai não encontrada.",
            tx,
          );
          if (parent.status === "ARCHIVED") {
            throw new DomainError(
              "FOLDER_ARCHIVED",
              "Não é possível criar subpastas dentro de uma pasta arquivada.",
            );
          }
          parentPath = parent.materializedPath;
        }

        const existingSibling = await deps.folders.findByNameInParent(
          command.organizationId,
          command.parentId,
          normalizedName,
          tx,
        );
        if (existingSibling) {
          throw new DomainError(
            "FOLDER_NAME_ALREADY_IN_USE",
            "Já existe uma pasta com este nome no mesmo nível.",
          );
        }

        const folderId = deps.generateId();
        const created = await deps.folders.create(
          {
            id: folderId,
            organizationId: command.organizationId,
            parentId: command.parentId,
            name: normalizedName,
            materializedPath: buildFolderMaterializedPath(folderId, parentPath),
            createdBy: command.actorUserId,
          },
          tx,
        );

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "FOLDER_CREATED",
            resourceType: "FOLDER",
            resourceId: created.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              parentId: created.parentId,
              name: created.name,
            },
          },
          tx,
        );

        return created;
      });
    },

    async renameFolder(command: RenameFolderCommand): Promise<FolderEntity> {
      const normalizedName = normalizeFolderName(command.name);

      return deps.transactions.runInTransaction(async (tx) => {
        const folder = await requireActiveFolderInOrganization(
          deps.folders,
          command.organizationId,
          command.folderId,
          "Pasta não encontrada.",
          tx,
        );

        if (folder.status === "ARCHIVED") {
          throw new DomainError("FOLDER_ARCHIVED", "Não é possível renomear uma pasta arquivada.");
        }

        if (folder.name === normalizedName) {
          return folder;
        }

        const existingSibling = await deps.folders.findByNameInParent(
          command.organizationId,
          folder.parentId,
          normalizedName,
          tx,
        );
        if (existingSibling && existingSibling.id !== folder.id) {
          throw new DomainError(
            "FOLDER_NAME_ALREADY_IN_USE",
            "Já existe uma pasta com este nome no mesmo nível.",
          );
        }

        const updated = await deps.folders.rename(
          {
            id: folder.id,
            organizationId: command.organizationId,
            name: normalizedName,
            updatedBy: command.actorUserId,
          },
          tx,
        );
        if (!updated) {
          throw new DomainError("FOLDER_NOT_FOUND", "Pasta não encontrada.");
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "FOLDER_RENAMED",
            resourceType: "FOLDER",
            resourceId: updated.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              previousName: folder.name,
              nextName: updated.name,
            },
          },
          tx,
        );

        return updated;
      });
    },

    async moveFolder(command: MoveFolderCommand): Promise<FolderEntity> {
      return deps.transactions.runInTransaction(async (tx) => {
        const folder = await requireActiveFolderInOrganization(
          deps.folders,
          command.organizationId,
          command.folderId,
          "Pasta não encontrada.",
          tx,
        );

        if (folder.status === "ARCHIVED") {
          throw new DomainError("FOLDER_ARCHIVED", "Não é possível mover uma pasta arquivada.");
        }

        if (command.targetParentId === folder.id) {
          throw new DomainError(
            "FOLDER_HIERARCHY_CYCLE",
            "Não é possível mover uma pasta para dentro dela mesma.",
          );
        }

        if (folder.parentId === command.targetParentId) {
          return folder;
        }

        let targetParentPath: string | null = null;
        if (command.targetParentId !== null) {
          const targetParent = await requireActiveFolderInOrganization(
            deps.folders,
            command.organizationId,
            command.targetParentId,
            "Pasta de destino não encontrada.",
            tx,
          );
          if (targetParent.status === "ARCHIVED") {
            throw new DomainError(
              "FOLDER_ARCHIVED",
              "Não é possível mover uma pasta para dentro de uma pasta arquivada.",
            );
          }

          const targetAncestorIds = await deps.folders.listAncestorIds(
            command.organizationId,
            targetParent.id,
            tx,
          );
          if (isFolderHierarchyCycle(folder, targetParent, targetAncestorIds)) {
            throw new DomainError(
              "FOLDER_HIERARCHY_CYCLE",
              "Não é possível mover uma pasta para uma de suas subpastas.",
            );
          }

          targetParentPath = targetParent.materializedPath;
        }

        const existingSibling = await deps.folders.findByNameInParent(
          command.organizationId,
          command.targetParentId,
          folder.name,
          tx,
        );
        if (existingSibling && existingSibling.id !== folder.id) {
          throw new DomainError(
            "FOLDER_NAME_ALREADY_IN_USE",
            "Já existe uma pasta com este nome no destino.",
          );
        }

        const newMaterializedPath = buildFolderMaterializedPath(folder.id, targetParentPath);
        const moved = await deps.folders.moveSubtree(
          {
            organizationId: command.organizationId,
            folderId: folder.id,
            newParentId: command.targetParentId,
            oldMaterializedPath: folder.materializedPath,
            newMaterializedPath,
            updatedBy: command.actorUserId,
          },
          tx,
        );
        if (!moved) {
          throw new DomainError("FOLDER_NOT_FOUND", "Pasta não encontrada.");
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "FOLDER_MOVED",
            resourceType: "FOLDER",
            resourceId: moved.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              previousParentId: folder.parentId,
              nextParentId: command.targetParentId,
            },
          },
          tx,
        );

        return moved;
      });
    },

    async archiveFolder(command: ArchiveFolderCommand): Promise<FolderEntity> {
      return deps.transactions.runInTransaction(async (tx) => {
        const folder = await requireActiveFolderInOrganization(
          deps.folders,
          command.organizationId,
          command.folderId,
          "Pasta não encontrada.",
          tx,
        );

        if (folder.status === "ARCHIVED") {
          return folder;
        }

        const hasActiveChildren = await deps.folders.hasActiveChildren(
          command.organizationId,
          folder.id,
          tx,
        );
        if (hasActiveChildren) {
          throw new DomainError(
            "FOLDER_HAS_ACTIVE_CHILDREN",
            "Não é possível arquivar uma pasta que possui subpastas ativas.",
          );
        }

        const archived = await deps.folders.archive(
          {
            id: folder.id,
            organizationId: command.organizationId,
            updatedBy: command.actorUserId,
          },
          tx,
        );
        if (!archived) {
          throw new DomainError("FOLDER_NOT_FOUND", "Pasta não encontrada.");
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "FOLDER_ARCHIVED",
            resourceType: "FOLDER",
            resourceId: archived.id,
            result: "SUCCESS",
            requestId: command.requestId,
          },
          tx,
        );

        return archived;
      });
    },
  };
}
