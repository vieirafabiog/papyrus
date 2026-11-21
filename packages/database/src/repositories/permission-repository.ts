import type {
  AccessEffect,
  AccessScopeType,
  CreateRoleScopeAssignmentInput,
  PermissionEntity,
  PermissionScopeRepositoryPort,
  RoleEntity,
  RoleScopeAssignmentRecord,
  RoleWithPermissionsRecord,
  TransactionContext,
} from "@docuflow/domain";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { permissions, rolePermissions, roles, userRoleScopes } from "../schema/identity.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function toRoleEntity(row: typeof roles.$inferSelect): RoleEntity {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
  };
}

function toAssignmentRecord(row: typeof userRoleScopes.$inferSelect): RoleScopeAssignmentRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    groupId: row.groupId,
    roleId: row.roleId,
    scopeType: row.scopeType,
    scopeTargetId: row.scopeTargetId,
    effect: row.effect,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Drizzle PostgreSQL repository for organization-scoped RBAC+ACL role scope assignments.
 */
export function createPermissionScopeRepository(db: NodePgDatabase): PermissionScopeRepositoryPort {
  return {
    async findById(
      assignmentId: string,
      tx?: TransactionContext,
    ): Promise<RoleScopeAssignmentRecord | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(userRoleScopes)
        .where(eq(userRoleScopes.id, assignmentId))
        .limit(1);
      return row ? toAssignmentRecord(row) : null;
    },

    async findRoleById(
      organizationId: string,
      roleId: string,
      tx?: TransactionContext,
    ): Promise<RoleEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(roles)
        .where(and(eq(roles.organizationId, organizationId), eq(roles.id, roleId)))
        .limit(1);
      return row ? toRoleEntity(row) : null;
    },

    async findRoleByKey(
      organizationId: string,
      key: string,
      tx?: TransactionContext,
    ): Promise<RoleEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(roles)
        .where(and(eq(roles.organizationId, organizationId), eq(roles.key, key.trim())))
        .limit(1);
      return row ? toRoleEntity(row) : null;
    },

    async findMatchingAssignment(
      input: {
        readonly organizationId: string;
        readonly userId: string | null;
        readonly groupId: string | null;
        readonly roleId: string;
        readonly scopeType: AccessScopeType;
        readonly scopeTargetId: string | null;
        readonly effect: AccessEffect;
      },
      tx?: TransactionContext,
    ): Promise<RoleScopeAssignmentRecord | null> {
      const executor = resolveDbExecutor(db, tx);
      const conditions = [
        eq(userRoleScopes.organizationId, input.organizationId),
        input.userId !== null
          ? eq(userRoleScopes.userId, input.userId)
          : isNull(userRoleScopes.userId),
        input.groupId !== null
          ? eq(userRoleScopes.groupId, input.groupId)
          : isNull(userRoleScopes.groupId),
        eq(userRoleScopes.roleId, input.roleId),
        eq(userRoleScopes.scopeType, input.scopeType),
        input.scopeTargetId !== null
          ? eq(userRoleScopes.scopeTargetId, input.scopeTargetId)
          : isNull(userRoleScopes.scopeTargetId),
        eq(userRoleScopes.effect, input.effect),
      ];
      const [row] = await executor
        .select()
        .from(userRoleScopes)
        .where(and(...conditions))
        .limit(1);
      return row ? toAssignmentRecord(row) : null;
    },

    async listAssignmentsForOrganization(
      organizationId: string,
      tx?: TransactionContext,
    ): Promise<readonly RoleScopeAssignmentRecord[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select()
        .from(userRoleScopes)
        .where(eq(userRoleScopes.organizationId, organizationId))
        .orderBy(asc(userRoleScopes.createdAt), asc(userRoleScopes.id));
      return rows.map(toAssignmentRecord);
    },

    async createAssignment(
      input: CreateRoleScopeAssignmentInput,
      tx?: TransactionContext,
    ): Promise<RoleScopeAssignmentRecord> {
      const executor = resolveDbExecutor(db, tx);
      const [inserted] = await executor
        .insert(userRoleScopes)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          userId: input.userId,
          groupId: input.groupId,
          roleId: input.roleId,
          scopeType: input.scopeType,
          scopeTargetId: input.scopeTargetId,
          effect: input.effect,
          createdBy: input.createdBy,
        })
        .returning();
      if (!inserted) {
        throw new Error("Falha ao inserir atribuição de permissão em user_role_scopes.");
      }
      return toAssignmentRecord(inserted);
    },

    async deleteAssignment(
      organizationId: string,
      assignmentId: string,
      tx?: TransactionContext,
    ): Promise<RoleScopeAssignmentRecord | null> {
      const executor = resolveDbExecutor(db, tx);
      const [deleted] = await executor
        .delete(userRoleScopes)
        .where(
          and(
            eq(userRoleScopes.organizationId, organizationId),
            eq(userRoleScopes.id, assignmentId),
          ),
        )
        .returning();
      return deleted ? toAssignmentRecord(deleted) : null;
    },

    async listRolesWithPermissions(
      organizationId: string,
      tx?: TransactionContext,
    ): Promise<readonly RoleWithPermissionsRecord[]> {
      const executor = resolveDbExecutor(db, tx);
      const roleRows = await executor
        .select()
        .from(roles)
        .where(eq(roles.organizationId, organizationId))
        .orderBy(asc(roles.name), asc(roles.id));

      if (roleRows.length === 0) {
        return [];
      }

      const roleIds = roleRows.map((role) => role.id);
      const permRows = await executor
        .select({
          roleId: rolePermissions.roleId,
          id: permissions.id,
          action: permissions.action,
          resource: permissions.resource,
        })
        .from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(inArray(rolePermissions.roleId, roleIds))
        .orderBy(asc(permissions.resource), asc(permissions.action));

      const permsByRole = new Map<string, PermissionEntity[]>();
      for (const perm of permRows) {
        const list = permsByRole.get(perm.roleId) ?? [];
        list.push({
          id: perm.id,
          action: perm.action,
          resource: perm.resource,
        });
        permsByRole.set(perm.roleId, list);
      }

      return roleRows.map((row) => ({
        ...toRoleEntity(row),
        permissions: permsByRole.get(row.id) ?? [],
      }));
    },
  };
}
