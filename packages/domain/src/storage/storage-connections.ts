import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type {
  StorageConnectionEntity,
  StorageConnectionKind,
  StorageConnectionRepositoryPort,
  StorageConnectionStatus,
} from "../ports/storage-connection-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";

export type StorageNonSecretConfigMap = Readonly<Record<string, string | number | boolean | null>>;

export interface StorageConnectionView {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly kind: StorageConnectionKind;
  readonly isDefault: boolean;
  readonly status: StorageConnectionStatus;
  readonly nonSecretConfig: StorageNonSecretConfigMap;
  readonly hasCredentials: boolean;
  readonly lastHealthCheckAt: string | null;
  readonly lastHealthMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StorageConnectionHealthOutput {
  readonly healthy: boolean;
  readonly message: string;
  readonly checkedAt: Date;
}

export interface StorageConnectionHealthTesterPort {
  testConnection(connection: StorageConnectionEntity): Promise<StorageConnectionHealthOutput>;
}

export interface SecretEncryptorPort {
  encrypt(credentials: Readonly<Record<string, string>>): string;
}

export interface StorageConnectionAdminServiceDependencies {
  readonly connections: StorageConnectionRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly healthTester: StorageConnectionHealthTesterPort;
  readonly secretEncryptor?: SecretEncryptorPort | undefined;
  readonly generateId: () => string;
  readonly now?: (() => Date) | undefined;
}

export interface CreateStorageConnectionCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly name: string;
  readonly kind: StorageConnectionKind;
  readonly isDefault?: boolean | undefined;
  readonly nonSecretConfig: StorageNonSecretConfigMap;
  readonly credentials?: Readonly<Record<string, string>> | undefined;
}

export interface UpdateStorageConnectionCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly connectionId: string;
  readonly name?: string | undefined;
  readonly isDefault?: boolean | undefined;
  readonly nonSecretConfig?: StorageNonSecretConfigMap | undefined;
  readonly credentials?: Readonly<Record<string, string>> | undefined;
}

export interface StorageConnectionTargetCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly connectionId: string;
}

export interface StorageConnectionHealthCheckResult {
  readonly connection: StorageConnectionView;
  readonly health: {
    readonly healthy: boolean;
    readonly message: string;
    readonly checkedAt: string;
  };
}

export interface StorageConnectionAdminService {
  listConnections(organizationId: string): Promise<readonly StorageConnectionView[]>;
  createConnection(command: CreateStorageConnectionCommand): Promise<StorageConnectionView>;
  updateConnection(command: UpdateStorageConnectionCommand): Promise<StorageConnectionView>;
  activateConnection(command: StorageConnectionTargetCommand): Promise<StorageConnectionView>;
  deactivateConnection(command: StorageConnectionTargetCommand): Promise<StorageConnectionView>;
  setDefaultConnection(command: StorageConnectionTargetCommand): Promise<StorageConnectionView>;
  testConnection(
    command: StorageConnectionTargetCommand,
  ): Promise<StorageConnectionHealthCheckResult>;
}

export function toStorageConnectionView(entity: StorageConnectionEntity): StorageConnectionView {
  return {
    id: entity.id,
    organizationId: entity.organizationId,
    name: entity.name,
    kind: entity.kind,
    isDefault: entity.isDefault,
    status: entity.status,
    nonSecretConfig: entity.nonSecretConfig,
    hasCredentials: entity.encryptedSecretRef !== null,
    lastHealthCheckAt: entity.lastHealthCheckAt,
    lastHealthMessage: entity.lastHealthMessage,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

function normalizeConnectionName(rawName: string): string {
  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    throw new DomainError(
      "INVALID_STORAGE_CONNECTION",
      "O nome da conexão de armazenamento é obrigatório.",
    );
  }
  return trimmed;
}

function encryptCredentialsIfProvided(
  credentials: Readonly<Record<string, string>> | undefined,
  encryptor: SecretEncryptorPort | undefined,
): string | null | undefined {
  if (credentials === undefined) {
    return undefined;
  }
  if (Object.keys(credentials).length === 0) {
    return null;
  }
  if (!encryptor) {
    throw new DomainError(
      "SECRET_ENCRYPTOR_UNAVAILABLE",
      "Serviço de criptografia de credenciais de armazenamento não configurado.",
    );
  }
  return encryptor.encrypt(credentials);
}

export function createStorageConnectionAdminService(
  deps: StorageConnectionAdminServiceDependencies,
): StorageConnectionAdminService {
  const now = deps.now ?? (() => new Date());

  return {
    async listConnections(organizationId: string): Promise<readonly StorageConnectionView[]> {
      const items = await deps.connections.listByOrganization(organizationId);
      return items.map(toStorageConnectionView);
    },

    async createConnection(
      command: CreateStorageConnectionCommand,
    ): Promise<StorageConnectionView> {
      const normalizedName = normalizeConnectionName(command.name);
      const encryptedSecretRef =
        encryptCredentialsIfProvided(command.credentials, deps.secretEncryptor) ?? null;

      return deps.transactions.runInTransaction(async (tx) => {
        const existingConnections = await deps.connections.listByOrganization(
          command.organizationId,
        );
        const duplicate = existingConnections.find(
          (item) => item.name.trim().toLowerCase() === normalizedName.toLowerCase(),
        );
        if (duplicate) {
          throw new DomainError(
            "STORAGE_CONNECTION_NAME_IN_USE",
            "Já existe uma conexão de armazenamento cadastrada com este nome.",
          );
        }

        const isDefault = command.isDefault ?? false;
        if (isDefault) {
          const currentDefault = await deps.connections.findDefaultByOrganization(
            command.organizationId,
            tx,
          );
          if (currentDefault) {
            await deps.connections.update(currentDefault.id, { isDefault: false }, tx);
          }
        }

        const created = await deps.connections.create(
          {
            id: deps.generateId(),
            organizationId: command.organizationId,
            name: normalizedName,
            kind: command.kind,
            isDefault,
            nonSecretConfig: command.nonSecretConfig,
            encryptedSecretRef,
          },
          tx,
        );

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "STORAGE_CONNECTION_CREATED",
            resourceType: "STORAGE_CONNECTION",
            resourceId: created.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              kind: created.kind,
              isDefault: created.isDefault,
            },
          },
          tx,
        );

        return toStorageConnectionView(created);
      });
    },

    async updateConnection(
      command: UpdateStorageConnectionCommand,
    ): Promise<StorageConnectionView> {
      const encryptedSecretRef = encryptCredentialsIfProvided(
        command.credentials,
        deps.secretEncryptor,
      );

      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.connections.findById(command.connectionId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError(
            "STORAGE_CONNECTION_NOT_FOUND",
            "Conexão de armazenamento não encontrada.",
          );
        }

        let normalizedName: string | undefined;
        if (command.name !== undefined) {
          normalizedName = normalizeConnectionName(command.name);
          const all = await deps.connections.listByOrganization(command.organizationId);
          const duplicate = all.find(
            (item) =>
              item.id !== existing.id &&
              item.name.trim().toLowerCase() === normalizedName?.toLowerCase(),
          );
          if (duplicate) {
            throw new DomainError(
              "STORAGE_CONNECTION_NAME_IN_USE",
              "Já existe uma conexão de armazenamento cadastrada com este nome.",
            );
          }
        }

        if (command.isDefault === true) {
          if (existing.status === "INACTIVE") {
            throw new DomainError(
              "STORAGE_CONNECTION_INACTIVE",
              "Não é possível definir uma conexão inativa como padrão.",
            );
          }
          const currentDefault = await deps.connections.findDefaultByOrganization(
            command.organizationId,
            tx,
          );
          if (currentDefault && currentDefault.id !== existing.id) {
            await deps.connections.update(currentDefault.id, { isDefault: false }, tx);
          }
        }

        const updated = await deps.connections.update(
          existing.id,
          {
            name: normalizedName,
            isDefault: command.isDefault,
            nonSecretConfig: command.nonSecretConfig,
            encryptedSecretRef,
          },
          tx,
        );
        if (!updated) {
          throw new DomainError(
            "STORAGE_CONNECTION_NOT_FOUND",
            "Conexão de armazenamento não encontrada.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "STORAGE_CONNECTION_UPDATED",
            resourceType: "STORAGE_CONNECTION",
            resourceId: updated.id,
            result: "SUCCESS",
            requestId: command.requestId,
          },
          tx,
        );

        return toStorageConnectionView(updated);
      });
    },

    async activateConnection(
      command: StorageConnectionTargetCommand,
    ): Promise<StorageConnectionView> {
      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.connections.findById(command.connectionId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError(
            "STORAGE_CONNECTION_NOT_FOUND",
            "Conexão de armazenamento não encontrada.",
          );
        }

        if (existing.status === "ACTIVE") {
          return toStorageConnectionView(existing);
        }

        const updated = await deps.connections.update(existing.id, { status: "ACTIVE" }, tx);
        if (!updated) {
          throw new DomainError(
            "STORAGE_CONNECTION_NOT_FOUND",
            "Conexão de armazenamento não encontrada.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "STORAGE_CONNECTION_ACTIVATED",
            resourceType: "STORAGE_CONNECTION",
            resourceId: updated.id,
            result: "SUCCESS",
            requestId: command.requestId,
          },
          tx,
        );

        return toStorageConnectionView(updated);
      });
    },

    async deactivateConnection(
      command: StorageConnectionTargetCommand,
    ): Promise<StorageConnectionView> {
      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.connections.findById(command.connectionId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError(
            "STORAGE_CONNECTION_NOT_FOUND",
            "Conexão de armazenamento não encontrada.",
          );
        }

        if (existing.status === "INACTIVE") {
          return toStorageConnectionView(existing);
        }

        if (existing.isDefault) {
          throw new DomainError(
            "STORAGE_CONNECTION_IS_DEFAULT",
            "Não é possível desativar a conexão padrão antes de selecionar outro destino padrão.",
          );
        }

        const hasLinkedObjects = await deps.connections.hasLinkedFileObjects(existing.id, tx);
        if (hasLinkedObjects) {
          throw new DomainError(
            "STORAGE_CONNECTION_IN_USE",
            "Não é possível desativar a conexão pois ela ainda é necessária para leitura de arquivos existentes.",
          );
        }

        const updated = await deps.connections.update(existing.id, { status: "INACTIVE" }, tx);
        if (!updated) {
          throw new DomainError(
            "STORAGE_CONNECTION_NOT_FOUND",
            "Conexão de armazenamento não encontrada.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "STORAGE_CONNECTION_DEACTIVATED",
            resourceType: "STORAGE_CONNECTION",
            resourceId: updated.id,
            result: "SUCCESS",
            requestId: command.requestId,
          },
          tx,
        );

        return toStorageConnectionView(updated);
      });
    },

    async setDefaultConnection(
      command: StorageConnectionTargetCommand,
    ): Promise<StorageConnectionView> {
      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.connections.findById(command.connectionId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError(
            "STORAGE_CONNECTION_NOT_FOUND",
            "Conexão de armazenamento não encontrada.",
          );
        }

        if (existing.status === "INACTIVE") {
          throw new DomainError(
            "STORAGE_CONNECTION_INACTIVE",
            "Não é possível definir uma conexão inativa como destino padrão.",
          );
        }

        if (existing.isDefault) {
          return toStorageConnectionView(existing);
        }

        const currentDefault = await deps.connections.findDefaultByOrganization(
          command.organizationId,
          tx,
        );
        if (currentDefault && currentDefault.id !== existing.id) {
          await deps.connections.update(currentDefault.id, { isDefault: false }, tx);
        }

        const updated = await deps.connections.update(existing.id, { isDefault: true }, tx);
        if (!updated) {
          throw new DomainError(
            "STORAGE_CONNECTION_NOT_FOUND",
            "Conexão de armazenamento não encontrada.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "STORAGE_CONNECTION_DEFAULT_CHANGED",
            resourceType: "STORAGE_CONNECTION",
            resourceId: updated.id,
            result: "SUCCESS",
            requestId: command.requestId,
          },
          tx,
        );

        return toStorageConnectionView(updated);
      });
    },

    async testConnection(
      command: StorageConnectionTargetCommand,
    ): Promise<StorageConnectionHealthCheckResult> {
      const existing = await deps.connections.findById(command.connectionId);
      if (!existing || existing.organizationId !== command.organizationId) {
        throw new DomainError(
          "STORAGE_CONNECTION_NOT_FOUND",
          "Conexão de armazenamento não encontrada.",
        );
      }

      let health: StorageConnectionHealthOutput;
      try {
        health = await deps.healthTester.testConnection(existing);
      } catch {
        health = {
          healthy: false,
          message: "Falha ao executar verificação de saúde na conexão de armazenamento.",
          checkedAt: now(),
        };
      }

      const nextStatus: StorageConnectionStatus =
        existing.status === "INACTIVE" ? "INACTIVE" : health.healthy ? "ACTIVE" : "ERROR";

      return deps.transactions.runInTransaction(async (tx) => {
        const updated = await deps.connections.update(
          existing.id,
          {
            status: nextStatus,
            lastHealthCheckAt: health.checkedAt.toISOString(),
            lastHealthMessage: health.message,
          },
          tx,
        );
        if (!updated) {
          throw new DomainError(
            "STORAGE_CONNECTION_NOT_FOUND",
            "Conexão de armazenamento não encontrada.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "STORAGE_CONNECTION_TESTED",
            resourceType: "STORAGE_CONNECTION",
            resourceId: updated.id,
            result: health.healthy ? "SUCCESS" : "FAILURE",
            requestId: command.requestId,
            metadata: {
              healthy: health.healthy,
            },
          },
          tx,
        );

        return {
          connection: toStorageConnectionView(updated),
          health: {
            healthy: health.healthy,
            message: health.message,
            checkedAt: health.checkedAt.toISOString(),
          },
        };
      });
    },
  };
}
