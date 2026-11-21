import type { FileObjectEntity } from "../documents/document.types.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type {
  StorageConnectionEntity,
  StorageConnectionRepositoryPort,
  StorageRoutingRuleEntity,
  StorageRoutingRuleRepositoryPort,
} from "../ports/storage-connection-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";

export type StorageRouteSource =
  | "EXPLICIT"
  | "CATEGORY_RULE"
  | "INSTALLATION_RULE"
  | "ORGANIZATION_DEFAULT"
  | "PERSISTED_OBJECT";

export interface ResolvedStorageTarget {
  readonly connection: StorageConnectionEntity;
  readonly source: StorageRouteSource;
}

export interface ResolveWriteTargetInput {
  readonly organizationId: string;
  readonly categoryId?: string | null | undefined;
  readonly explicitConnectionId?: string | null | undefined;
}

export interface ResolveReadTargetInput {
  readonly organizationId: string;
  readonly storageConnectionId: string;
}

export interface BindNewFileObjectInput {
  readonly id: string;
  readonly resolvedTarget: ResolvedStorageTarget;
  readonly objectKey: string;
  readonly originalFileName: string;
  readonly detectedContentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly createdAt?: string | undefined;
}

export interface SetStorageRoutingRuleCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly categoryId: string | null;
  readonly storageConnectionId: string;
}

export interface ClearCategoryRoutingRuleCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly categoryId: string;
}

export interface StorageRouterDependencies {
  readonly connections: StorageConnectionRepositoryPort;
  readonly routingRules: StorageRoutingRuleRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
}

export interface StorageRouterService {
  listRules(organizationId: string): Promise<readonly StorageRoutingRuleEntity[]>;
  resolveWriteTarget(
    input: ResolveWriteTargetInput,
    tx?: TransactionContext,
  ): Promise<ResolvedStorageTarget>;
  resolveReadTarget(
    input: ResolveReadTargetInput,
    tx?: TransactionContext,
  ): Promise<ResolvedStorageTarget>;
  setRoutingRule(command: SetStorageRoutingRuleCommand): Promise<StorageRoutingRuleEntity>;
  clearCategoryRule(command: ClearCategoryRoutingRuleCommand): Promise<boolean>;
}

/**
 * Binds the effectively resolved storage connection ID onto a newly created `FileObjectEntity`
 * so subsequent reads always use the connection where the binary was actually written.
 */
export function bindFileObjectToStorageTarget(input: BindNewFileObjectInput): FileObjectEntity {
  return {
    id: input.id,
    storageConnectionId: input.resolvedTarget.connection.id,
    objectKey: input.objectKey,
    originalFileName: input.originalFileName,
    detectedContentType: input.detectedContentType,
    sizeBytes: input.sizeBytes,
    checksumSha256: input.checksumSha256,
    status: "UPLOADING",
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function assertWritableConnection(
  connection: StorageConnectionEntity | null,
  organizationId: string,
  notFoundMessage: string,
): StorageConnectionEntity {
  if (!connection || connection.organizationId !== organizationId) {
    throw new DomainError("STORAGE_CONNECTION_NOT_FOUND", notFoundMessage);
  }
  if (connection.status !== "ACTIVE") {
    throw new DomainError(
      "STORAGE_CONNECTION_INACTIVE",
      "A conexão de armazenamento selecionada não está ativa para novos envios.",
    );
  }
  return connection;
}

/**
 * Resolves installation default and category override storage targets without
 * ever moving existing objects when routing rules are modified.
 */
export function createStorageRouterService(deps: StorageRouterDependencies): StorageRouterService {
  return {
    async listRules(organizationId: string): Promise<readonly StorageRoutingRuleEntity[]> {
      return deps.routingRules.listByOrganization(organizationId);
    },

    async resolveWriteTarget(
      input: ResolveWriteTargetInput,
      tx?: TransactionContext,
    ): Promise<ResolvedStorageTarget> {
      if (input.explicitConnectionId) {
        const explicitConn = await deps.connections.findById(input.explicitConnectionId, tx);
        return {
          connection: assertWritableConnection(
            explicitConn,
            input.organizationId,
            "Conexão de armazenamento explícita não encontrada.",
          ),
          source: "EXPLICIT",
        };
      }

      if (input.categoryId) {
        const categoryRule = await deps.routingRules.findByOrganizationAndCategory(
          input.organizationId,
          input.categoryId,
          tx,
        );
        if (categoryRule) {
          const categoryConn = await deps.connections.findById(
            categoryRule.storageConnectionId,
            tx,
          );
          return {
            connection: assertWritableConnection(
              categoryConn,
              input.organizationId,
              "A conexão configurada na regra da categoria não foi encontrada.",
            ),
            source: "CATEGORY_RULE",
          };
        }
      }

      const installationRule = await deps.routingRules.findByOrganizationAndCategory(
        input.organizationId,
        null,
        tx,
      );
      if (installationRule) {
        const ruleConn = await deps.connections.findById(installationRule.storageConnectionId, tx);
        return {
          connection: assertWritableConnection(
            ruleConn,
            input.organizationId,
            "A conexão configurada na regra padrão da instalação não foi encontrada.",
          ),
          source: "INSTALLATION_RULE",
        };
      }

      const defaultConn = await deps.connections.findDefaultByOrganization(
        input.organizationId,
        tx,
      );
      return {
        connection: assertWritableConnection(
          defaultConn,
          input.organizationId,
          "Nenhuma conexão de armazenamento padrão ativa está configurada.",
        ),
        source: "ORGANIZATION_DEFAULT",
      };
    },

    async resolveReadTarget(
      input: ResolveReadTargetInput,
      tx?: TransactionContext,
    ): Promise<ResolvedStorageTarget> {
      const persistedConn = await deps.connections.findById(input.storageConnectionId, tx);
      if (!persistedConn || persistedConn.organizationId !== input.organizationId) {
        throw new DomainError(
          "STORAGE_CONNECTION_NOT_FOUND",
          "Conexão de armazenamento vinculada ao arquivo não encontrada.",
        );
      }
      return {
        connection: persistedConn,
        source: "PERSISTED_OBJECT",
      };
    },

    async setRoutingRule(command: SetStorageRoutingRuleCommand): Promise<StorageRoutingRuleEntity> {
      return deps.transactions.runInTransaction(async (tx) => {
        const targetConn = await deps.connections.findById(command.storageConnectionId, tx);
        assertWritableConnection(
          targetConn,
          command.organizationId,
          "Conexão de armazenamento de destino não encontrada.",
        );

        const saved = await deps.routingRules.upsertRule(
          {
            id: deps.generateId(),
            organizationId: command.organizationId,
            categoryId: command.categoryId,
            storageConnectionId: command.storageConnectionId,
            actorUserId: command.actorUserId,
          },
          tx,
        );

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "STORAGE_ROUTING_RULE_UPDATED",
            resourceType: "STORAGE_ROUTING_RULE",
            resourceId: saved.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              categoryId: saved.categoryId,
              storageConnectionId: saved.storageConnectionId,
            },
          },
          tx,
        );

        return saved;
      });
    },

    async clearCategoryRule(command: ClearCategoryRoutingRuleCommand): Promise<boolean> {
      return deps.transactions.runInTransaction(async (tx) => {
        const removed = await deps.routingRules.deleteCategoryRule(
          command.organizationId,
          command.categoryId,
          tx,
        );

        if (removed) {
          await deps.audit.append(
            {
              organizationId: command.organizationId,
              actorUserId: command.actorUserId,
              action: "STORAGE_ROUTING_RULE_REMOVED",
              resourceType: "STORAGE_ROUTING_RULE",
              resourceId: command.categoryId,
              result: "SUCCESS",
              requestId: command.requestId,
              metadata: {
                categoryId: command.categoryId,
              },
            },
            tx,
          );
        }

        return removed;
      });
    },
  };
}
