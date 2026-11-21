import { createAuditWriter } from "../audit/audit-writer.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { CategoryRepositoryPort } from "../ports/category-repository.port.js";
import type { DocumentRepositoryPort } from "../ports/document-repository.port.js";
import type { FolderRepositoryPort } from "../ports/folder-repository.port.js";
import type { GroupRepositoryPort } from "../ports/group-repository.port.js";
import type {
  PermissionScopeRepositoryPort,
  RoleScopeAssignmentRecord,
  RoleWithPermissionsRecord,
} from "../ports/permission-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import type { UserRepositoryPort } from "../ports/user-repository.port.js";
import type { AccessEffect, AccessScopeType } from "./access.types.js";

export interface PermissionAdministrationDependencies {
  readonly permissionScopes: PermissionScopeRepositoryPort;
  readonly users: UserRepositoryPort;
  readonly groups: GroupRepositoryPort;
  readonly documents?: DocumentRepositoryPort | undefined;
  readonly folders?: FolderRepositoryPort | undefined;
  readonly categories?: CategoryRepositoryPort | undefined;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
}

export interface AssignRoleScopeCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly ipAddress?: string | null | undefined;
  readonly subjectType: "USER" | "GROUP";
  readonly subjectId: string;
  readonly roleId: string;
  readonly scopeType: AccessScopeType;
  readonly scopeTargetId?: string | null | undefined;
  readonly effect?: AccessEffect | undefined;
}

export interface RevokeRoleScopeCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly ipAddress?: string | null | undefined;
  readonly assignmentId: string;
}

export interface PermissionAdministrationService {
  listRoles?(organizationId: string): Promise<readonly RoleWithPermissionsRecord[]>;
  listAssignments(organizationId: string): Promise<readonly RoleScopeAssignmentRecord[]>;
  assignRoleScope(command: AssignRoleScopeCommand): Promise<RoleScopeAssignmentRecord>;
  revokeRoleScope(command: RevokeRoleScopeCommand): Promise<RoleScopeAssignmentRecord>;
}

async function validateScopeTarget(
  deps: PermissionAdministrationDependencies,
  organizationId: string,
  scopeType: AccessScopeType,
  scopeTargetId: string | null,
  tx: TransactionContext,
): Promise<void> {
  if (scopeType === "GLOBAL") {
    if (scopeTargetId !== null) {
      throw new DomainError(
        "INVALID_PERMISSION_SCOPE",
        "Escopo GLOBAL não deve informar identificador de recurso alvo.",
      );
    }
    return;
  }

  if (!scopeTargetId) {
    throw new DomainError(
      "INVALID_PERMISSION_SCOPE",
      `Escopo ${scopeType} exige o identificador do recurso alvo.`,
    );
  }

  if (scopeType === "CATEGORY" && deps.categories) {
    const category = await deps.categories.findById(scopeTargetId, tx);
    if (!category || category.organizationId !== organizationId) {
      throw new DomainError("CATEGORY_NOT_FOUND", "Categoria alvo não encontrada na organização.");
    }
  } else if (scopeType === "FOLDER" && deps.folders) {
    const folder = await deps.folders.findById(scopeTargetId, tx);
    if (!folder || folder.organizationId !== organizationId) {
      throw new DomainError("FOLDER_NOT_FOUND", "Pasta alvo não encontrada na organização.");
    }
  } else if (scopeType === "DOCUMENT" && deps.documents) {
    const doc = await deps.documents.findById(scopeTargetId, tx);
    if (!doc || doc.organizationId !== organizationId) {
      throw new DomainError("DOCUMENT_NOT_FOUND", "Documento alvo não encontrado na organização.");
    }
  }
}

/**
 * Manages scoped RBAC+ACL role assignments (`ALLOW`/`DENY` by `GLOBAL`, `CATEGORY`, `FOLDER`,
 * or `DOCUMENT`) and records transactional audit events on every permission change.
 */
export function createPermissionAdministrationService(
  deps: PermissionAdministrationDependencies,
): PermissionAdministrationService {
  const auditWriter = createAuditWriter({ repository: deps.audit });

  return {
    listRoles(organizationId: string): Promise<readonly RoleWithPermissionsRecord[]> {
      return deps.permissionScopes.listRolesWithPermissions
        ? deps.permissionScopes.listRolesWithPermissions(organizationId)
        : Promise.resolve([]);
    },

    listAssignments(organizationId: string): Promise<readonly RoleScopeAssignmentRecord[]> {
      return deps.permissionScopes.listAssignmentsForOrganization(organizationId);
    },

    async assignRoleScope(command: AssignRoleScopeCommand): Promise<RoleScopeAssignmentRecord> {
      const normalizedScopeTargetId = command.scopeTargetId ?? null;
      const effect = command.effect ?? "ALLOW";

      return deps.transactions.runInTransaction(async (tx) => {
        if (command.subjectType === "USER") {
          const user = await deps.users.findById(command.subjectId, tx);
          if (!user || user.organizationId !== command.organizationId) {
            throw new DomainError("USER_NOT_FOUND", "Usuário alvo não encontrado na organização.");
          }
        } else {
          const group = await deps.groups.findById(command.subjectId, tx);
          if (!group || group.organizationId !== command.organizationId) {
            throw new DomainError("GROUP_NOT_FOUND", "Grupo alvo não encontrado na organização.");
          }
        }

        const role = await deps.permissionScopes.findRoleById(
          command.organizationId,
          command.roleId,
          tx,
        );
        if (!role) {
          throw new DomainError("ROLE_NOT_FOUND", "Papel (role) informado não existe.");
        }

        await validateScopeTarget(
          deps,
          command.organizationId,
          command.scopeType,
          normalizedScopeTargetId,
          tx,
        );

        const userId = command.subjectType === "USER" ? command.subjectId : null;
        const groupId = command.subjectType === "GROUP" ? command.subjectId : null;

        const duplicate = await deps.permissionScopes.findMatchingAssignment(
          {
            organizationId: command.organizationId,
            userId,
            groupId,
            roleId: role.id,
            scopeType: command.scopeType,
            scopeTargetId: normalizedScopeTargetId,
            effect,
          },
          tx,
        );
        if (duplicate) {
          throw new DomainError(
            "PERMISSION_ASSIGNMENT_ALREADY_EXISTS",
            "Esta atribuição de permissão no escopo informado já existe.",
          );
        }

        const created = await deps.permissionScopes.createAssignment(
          {
            id: deps.generateId(),
            organizationId: command.organizationId,
            userId,
            groupId,
            roleId: role.id,
            scopeType: command.scopeType,
            scopeTargetId: normalizedScopeTargetId,
            effect,
            createdBy: command.actorUserId,
          },
          tx,
        );

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "PERMISSION_ASSIGNED",
            resourceType: "ROLE_SCOPE",
            resourceId: created.id,
            result: "SUCCESS",
            requestId: command.requestId,
            ipAddress: command.ipAddress ?? null,
            metadata: {
              subjectType: command.subjectType,
              subjectId: command.subjectId,
              roleId: role.id,
              roleKey: role.key,
              scopeType: created.scopeType,
              scopeTargetId: created.scopeTargetId,
              effect: created.effect,
            },
          },
          tx,
        );

        return created;
      });
    },

    async revokeRoleScope(command: RevokeRoleScopeCommand): Promise<RoleScopeAssignmentRecord> {
      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.permissionScopes.findById(command.assignmentId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError(
            "PERMISSION_ASSIGNMENT_NOT_FOUND",
            "Atribuição de permissão não encontrada.",
          );
        }

        const deleted = await deps.permissionScopes.deleteAssignment(
          command.organizationId,
          command.assignmentId,
          tx,
        );
        if (!deleted) {
          throw new DomainError(
            "PERMISSION_ASSIGNMENT_NOT_FOUND",
            "Atribuição de permissão não encontrada.",
          );
        }

        const subjectType = deleted.userId !== null ? "USER" : "GROUP";
        const subjectId = deleted.userId ?? deleted.groupId;

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "PERMISSION_REVOKED",
            resourceType: "ROLE_SCOPE",
            resourceId: deleted.id,
            result: "SUCCESS",
            requestId: command.requestId,
            ipAddress: command.ipAddress ?? null,
            metadata: {
              subjectType,
              subjectId,
              roleId: deleted.roleId,
              scopeType: deleted.scopeType,
              scopeTargetId: deleted.scopeTargetId,
              effect: deleted.effect,
            },
          },
          tx,
        );

        return deleted;
      });
    },
  };
}
