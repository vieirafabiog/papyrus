import type { AccessEffect, AccessScopeType, RoleEntity } from "../access/access.types.js";
import type { TransactionContext } from "./transaction.port.js";

export type PermissionSubjectType = "USER" | "GROUP";

export interface RoleScopeAssignmentRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string | null;
  readonly groupId: string | null;
  readonly roleId: string;
  readonly scopeType: AccessScopeType;
  readonly scopeTargetId: string | null;
  readonly effect: AccessEffect;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface CreateRoleScopeAssignmentInput {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string | null;
  readonly groupId: string | null;
  readonly roleId: string;
  readonly scopeType: AccessScopeType;
  readonly scopeTargetId: string | null;
  readonly effect: AccessEffect;
  readonly createdBy: string;
}

export interface PermissionScopeRepositoryPort {
  findById(
    assignmentId: string,
    tx?: TransactionContext,
  ): Promise<RoleScopeAssignmentRecord | null>;
  findRoleById(
    organizationId: string,
    roleId: string,
    tx?: TransactionContext,
  ): Promise<RoleEntity | null>;
  findRoleByKey(
    organizationId: string,
    key: string,
    tx?: TransactionContext,
  ): Promise<RoleEntity | null>;
  findMatchingAssignment(
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
  ): Promise<RoleScopeAssignmentRecord | null>;
  listAssignmentsForOrganization(
    organizationId: string,
    tx?: TransactionContext,
  ): Promise<readonly RoleScopeAssignmentRecord[]>;
  createAssignment(
    input: CreateRoleScopeAssignmentInput,
    tx?: TransactionContext,
  ): Promise<RoleScopeAssignmentRecord>;
  deleteAssignment(
    organizationId: string,
    assignmentId: string,
    tx?: TransactionContext,
  ): Promise<RoleScopeAssignmentRecord | null>;
}
