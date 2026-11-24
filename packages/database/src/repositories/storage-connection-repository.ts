import type {
  CreateStorageConnectionInput,
  StorageConnectionEntity,
  StorageConnectionRepositoryPort,
  StorageRoutingRuleEntity,
  StorageRoutingRuleRepositoryPort,
  TransactionContext,
  UpdateStorageConnectionInput,
  UpsertStorageRoutingRuleInput,
} from "@papyrus/domain";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { fileObjects, storageConnections, storageRoutingRules } from "../schema/storage.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function toStorageConnectionEntity(
  row: typeof storageConnections.$inferSelect,
): StorageConnectionEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    kind: row.kind,
    isDefault: row.isDefault,
    status: row.status,
    nonSecretConfig: row.nonSecretConfig,
    encryptedSecretRef: row.encryptedSecretPayload,
    lastHealthCheckAt: row.lastHealthCheckAt ? row.lastHealthCheckAt.toISOString() : null,
    lastHealthMessage: row.lastHealthMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMutableConfig(
  config: Readonly<Record<string, string | number | boolean | null>>,
): Record<string, string | number | boolean | null> {
  return { ...config };
}

export function createStorageConnectionRepository(
  db: NodePgDatabase,
): StorageConnectionRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<StorageConnectionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(storageConnections)
        .where(eq(storageConnections.id, id))
        .limit(1);
      return row ? toStorageConnectionEntity(row) : null;
    },

    async findDefaultByOrganization(
      organizationId: string,
      tx?: TransactionContext,
    ): Promise<StorageConnectionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(storageConnections)
        .where(
          and(
            eq(storageConnections.organizationId, organizationId),
            eq(storageConnections.isDefault, true),
          ),
        )
        .limit(1);
      return row ? toStorageConnectionEntity(row) : null;
    },

    async listByOrganization(organizationId: string): Promise<readonly StorageConnectionEntity[]> {
      const rows = await db
        .select()
        .from(storageConnections)
        .where(eq(storageConnections.organizationId, organizationId))
        .orderBy(asc(storageConnections.name), asc(storageConnections.id));
      return rows.map(toStorageConnectionEntity);
    },

    async create(
      input: CreateStorageConnectionInput,
      tx?: TransactionContext,
    ): Promise<StorageConnectionEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(storageConnections)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          name: input.name.trim(),
          kind: input.kind,
          isDefault: input.isDefault,
          nonSecretConfig: toMutableConfig(input.nonSecretConfig),
          encryptedSecretPayload: input.encryptedSecretRef,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to insert storage connection record.");
      }
      return toStorageConnectionEntity(row);
    },

    async update(
      id: string,
      input: UpdateStorageConnectionInput,
      tx?: TransactionContext,
    ): Promise<StorageConnectionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const patch: Partial<typeof storageConnections.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) {
        patch.name = input.name.trim();
      }
      if (input.isDefault !== undefined) {
        patch.isDefault = input.isDefault;
      }
      if (input.status !== undefined) {
        patch.status = input.status;
      }
      if (input.nonSecretConfig !== undefined) {
        patch.nonSecretConfig = toMutableConfig(input.nonSecretConfig);
      }
      if (input.encryptedSecretRef !== undefined) {
        patch.encryptedSecretPayload = input.encryptedSecretRef;
      }
      if (input.lastHealthCheckAt !== undefined) {
        patch.lastHealthCheckAt =
          input.lastHealthCheckAt !== null ? new Date(input.lastHealthCheckAt) : null;
      }
      if (input.lastHealthMessage !== undefined) {
        patch.lastHealthMessage = input.lastHealthMessage;
      }

      const [row] = await executor
        .update(storageConnections)
        .set(patch)
        .where(eq(storageConnections.id, id))
        .returning();

      return row ? toStorageConnectionEntity(row) : null;
    },

    async hasLinkedFileObjects(connectionId: string, tx?: TransactionContext): Promise<boolean> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({ total: count() })
        .from(fileObjects)
        .where(eq(fileObjects.storageConnectionId, connectionId));
      return Number(row?.total ?? 0) > 0;
    },
  };
}

function toStorageRoutingRuleEntity(
  row: typeof storageRoutingRules.$inferSelect,
): StorageRoutingRuleEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    categoryId: row.categoryId,
    storageConnectionId: row.storageConnectionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createStorageRoutingRuleRepository(
  db: NodePgDatabase,
): StorageRoutingRuleRepositoryPort {
  return {
    async findByOrganizationAndCategory(
      organizationId: string,
      categoryId: string | null,
      tx?: TransactionContext,
    ): Promise<StorageRoutingRuleEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const categoryPredicate =
        categoryId === null
          ? isNull(storageRoutingRules.categoryId)
          : eq(storageRoutingRules.categoryId, categoryId);

      const [row] = await executor
        .select()
        .from(storageRoutingRules)
        .where(and(eq(storageRoutingRules.organizationId, organizationId), categoryPredicate))
        .limit(1);

      return row ? toStorageRoutingRuleEntity(row) : null;
    },

    async listByOrganization(organizationId: string): Promise<readonly StorageRoutingRuleEntity[]> {
      const rows = await db
        .select()
        .from(storageRoutingRules)
        .where(eq(storageRoutingRules.organizationId, organizationId))
        .orderBy(asc(storageRoutingRules.createdAt), asc(storageRoutingRules.id));
      return rows.map(toStorageRoutingRuleEntity);
    },

    async upsertRule(
      input: UpsertStorageRoutingRuleInput,
      tx?: TransactionContext,
    ): Promise<StorageRoutingRuleEntity> {
      const executor = resolveDbExecutor(db, tx);
      const existing = await this.findByOrganizationAndCategory(
        input.organizationId,
        input.categoryId,
        tx,
      );

      if (existing) {
        const [updated] = await executor
          .update(storageRoutingRules)
          .set({
            storageConnectionId: input.storageConnectionId,
            updatedBy: input.actorUserId,
            updatedAt: new Date(),
          })
          .where(eq(storageRoutingRules.id, existing.id))
          .returning();
        if (!updated) {
          throw new Error("Failed to update storage routing rule.");
        }
        return toStorageRoutingRuleEntity(updated);
      }

      const [inserted] = await executor
        .insert(storageRoutingRules)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          categoryId: input.categoryId,
          storageConnectionId: input.storageConnectionId,
          createdBy: input.actorUserId,
          updatedBy: input.actorUserId,
        })
        .returning();
      if (!inserted) {
        throw new Error("Failed to insert storage routing rule.");
      }
      return toStorageRoutingRuleEntity(inserted);
    },

    async deleteCategoryRule(
      organizationId: string,
      categoryId: string,
      tx?: TransactionContext,
    ): Promise<boolean> {
      const executor = resolveDbExecutor(db, tx);
      const deleted = await executor
        .delete(storageRoutingRules)
        .where(
          and(
            eq(storageRoutingRules.organizationId, organizationId),
            eq(storageRoutingRules.categoryId, categoryId),
          ),
        )
        .returning({ id: storageRoutingRules.id });
      return deleted.length > 0;
    },
  };
}
