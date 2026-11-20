import type { UserEntity } from "../access/access.types.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import type { UserRepositoryPort } from "../ports/user-repository.port.js";

export interface PasswordHasherPort {
  hashPassword(plainPassword: string): Promise<string>;
}

export interface UserAdministrationServiceDependencies {
  readonly users: UserRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly passwordHasher: PasswordHasherPort;
  readonly generateId: () => string;
}

export interface CreateUserCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
}

export interface UpdateUserCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly targetUserId: string;
  readonly fullName: string;
}

export interface ChangeUserStatusCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly targetUserId: string;
}

export interface UserAdministrationService {
  listUsers(organizationId: string): Promise<readonly UserEntity[]>;
  createUser(command: CreateUserCommand): Promise<UserEntity>;
  updateUser(command: UpdateUserCommand): Promise<UserEntity>;
  deactivateUser(command: ChangeUserStatusCommand): Promise<UserEntity>;
  reactivateUser(command: ChangeUserStatusCommand): Promise<UserEntity>;
}

export function createUserAdministrationService(
  deps: UserAdministrationServiceDependencies,
): UserAdministrationService {
  return {
    async listUsers(organizationId: string): Promise<readonly UserEntity[]> {
      return deps.users.listByOrganization(organizationId);
    },

    async createUser(command: CreateUserCommand): Promise<UserEntity> {
      const normalizedEmail = command.email.trim().toLowerCase();
      const passwordHash = await deps.passwordHasher.hashPassword(command.password);

      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.users.findByEmail(command.organizationId, normalizedEmail, tx);
        if (existing) {
          throw new DomainError(
            "EMAIL_ALREADY_IN_USE",
            "Já existe um usuário cadastrado com este e-mail.",
          );
        }

        const created = await deps.users.create(
          {
            id: deps.generateId(),
            organizationId: command.organizationId,
            email: normalizedEmail,
            fullName: command.fullName.trim(),
            passwordHash,
            status: "ACTIVE",
          },
          tx,
        );

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "USER_CREATED",
            resourceType: "USER",
            resourceId: created.id,
            result: "SUCCESS",
            requestId: command.requestId,
          },
          tx,
        );

        return created;
      });
    },

    async updateUser(command: UpdateUserCommand): Promise<UserEntity> {
      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.users.findById(command.targetUserId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError("USER_NOT_FOUND", "Usuário não encontrado.");
        }

        const updated = await deps.users.update(
          existing.id,
          { fullName: command.fullName.trim() },
          tx,
        );
        if (!updated) {
          throw new DomainError("USER_NOT_FOUND", "Usuário não encontrado.");
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "USER_UPDATED",
            resourceType: "USER",
            resourceId: updated.id,
            result: "SUCCESS",
            requestId: command.requestId,
          },
          tx,
        );

        return updated;
      });
    },

    async deactivateUser(command: ChangeUserStatusCommand): Promise<UserEntity> {
      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.users.findById(command.targetUserId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError("USER_NOT_FOUND", "Usuário não encontrado.");
        }

        if (existing.status === "INACTIVE") {
          return existing;
        }

        const targetIsAdmin = await deps.users.isActiveGlobalAdmin(existing.id, tx);
        if (targetIsAdmin) {
          const activeAdmins = await deps.users.countActiveAdmins(command.organizationId, tx);
          if (activeAdmins <= 1) {
            throw new DomainError(
              "LAST_ACTIVE_ADMIN",
              "Não é possível desativar o último administrador ativo sem substituição.",
            );
          }
        }

        const updated = await deps.users.update(existing.id, { status: "INACTIVE" }, tx);
        if (!updated) {
          throw new DomainError("USER_NOT_FOUND", "Usuário não encontrado.");
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "USER_DEACTIVATED",
            resourceType: "USER",
            resourceId: updated.id,
            result: "SUCCESS",
            requestId: command.requestId,
          },
          tx,
        );

        return updated;
      });
    },

    async reactivateUser(command: ChangeUserStatusCommand): Promise<UserEntity> {
      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.users.findById(command.targetUserId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError("USER_NOT_FOUND", "Usuário não encontrado.");
        }

        if (existing.status === "ACTIVE") {
          return existing;
        }

        const updated = await deps.users.update(existing.id, { status: "ACTIVE" }, tx);
        if (!updated) {
          throw new DomainError("USER_NOT_FOUND", "Usuário não encontrado.");
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "USER_REACTIVATED",
            resourceType: "USER",
            resourceId: updated.id,
            result: "SUCCESS",
            requestId: command.requestId,
          },
          tx,
        );

        return updated;
      });
    },
  };
}
