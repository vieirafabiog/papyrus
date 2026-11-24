import type { GroupEntity, UserEntity } from "../access/access.types.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { GroupRepositoryPort } from "../ports/group-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import type { UserRepositoryPort } from "../ports/user-repository.port.js";

export interface GroupAdministrationServiceDependencies {
  readonly groups: GroupRepositoryPort;
  readonly users: UserRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
}

export interface CreateGroupCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly name: string;
  readonly description: string | null;
}

export interface GroupMemberCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly groupId: string;
  readonly targetUserId: string;
}

export interface GroupAdministrationService {
  listGroups(organizationId: string): Promise<readonly GroupEntity[]>;
  createGroup(command: CreateGroupCommand): Promise<GroupEntity>;
  listMembers(organizationId: string, groupId: string): Promise<readonly UserEntity[]>;
  addMember(command: GroupMemberCommand): Promise<void>;
  removeMember(command: GroupMemberCommand): Promise<void>;
}

export function createGroupAdministrationService(
  deps: GroupAdministrationServiceDependencies,
): GroupAdministrationService {
  return {
    async listGroups(organizationId: string): Promise<readonly GroupEntity[]> {
      return deps.groups.listByOrganization(organizationId);
    },

    async createGroup(command: CreateGroupCommand): Promise<GroupEntity> {
      const normalizedName = command.name.trim();
      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.groups.findByName(command.organizationId, normalizedName, tx);
        if (existing) {
          throw new DomainError(
            "GROUP_NAME_ALREADY_IN_USE",
            "Já existe um grupo cadastrado com este nome.",
          );
        }

        const created = await deps.groups.create(
          {
            id: deps.generateId(),
            organizationId: command.organizationId,
            name: normalizedName,
            description: command.description,
            createdBy: command.actorUserId,
          },
          tx,
        );

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "GROUP_CREATED",
            resourceType: "GROUP",
            resourceId: created.id,
            result: "SUCCESS",
            requestId: command.requestId,
          },
          tx,
        );

        return created;
      });
    },

    async listMembers(organizationId: string, groupId: string): Promise<readonly UserEntity[]> {
      const group = await deps.groups.findById(groupId);
      if (!group || group.organizationId !== organizationId) {
        throw new DomainError("GROUP_NOT_FOUND", "Grupo não encontrado.");
      }
      return deps.groups.listMembers(groupId);
    },

    async addMember(command: GroupMemberCommand): Promise<void> {
      await deps.transactions.runInTransaction(async (tx) => {
        const group = await deps.groups.findById(command.groupId, tx);
        if (!group || group.organizationId !== command.organizationId) {
          throw new DomainError("GROUP_NOT_FOUND", "Grupo não encontrado.");
        }

        const user = await deps.users.findById(command.targetUserId, tx);
        if (!user || user.organizationId !== command.organizationId) {
          throw new DomainError("USER_NOT_FOUND", "Usuário não encontrado.");
        }

        const alreadyMember = await deps.groups.isMember(group.id, user.id, tx);
        if (alreadyMember) {
          throw new DomainError(
            "DUPLICATE_GROUP_MEMBERSHIP",
            "O usuário já está vinculado a este grupo.",
          );
        }

        await deps.groups.addMember(
          {
            id: deps.generateId(),
            groupId: group.id,
            userId: user.id,
          },
          tx,
        );

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "GROUP_MEMBER_ADDED",
            resourceType: "GROUP",
            resourceId: group.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: { targetUserId: user.id },
          },
          tx,
        );
      });
    },

    async removeMember(command: GroupMemberCommand): Promise<void> {
      await deps.transactions.runInTransaction(async (tx) => {
        const group = await deps.groups.findById(command.groupId, tx);
        if (!group || group.organizationId !== command.organizationId) {
          throw new DomainError("GROUP_NOT_FOUND", "Grupo não encontrado.");
        }

        const removed = await deps.groups.removeMember(group.id, command.targetUserId, tx);
        if (!removed) {
          throw new DomainError(
            "GROUP_MEMBER_NOT_FOUND",
            "Vínculo entre usuário e grupo não encontrado.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "GROUP_MEMBER_REMOVED",
            resourceType: "GROUP",
            resourceId: group.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: { targetUserId: command.targetUserId },
          },
          tx,
        );
      });
    },
  };
}
