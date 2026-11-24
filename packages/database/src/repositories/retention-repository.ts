import type {
  CreateDocumentRetentionHoldInput,
  CreateRetentionPolicyInput,
  DocumentRetentionHoldEntity,
  DocumentRetentionHoldRepositoryPort,
  ReleaseDocumentRetentionHoldInput,
  RetentionPolicyEntity,
  RetentionPolicyRepositoryPort,
  TransactionContext,
  UpdateRetentionPolicyInput,
} from "@papyrus/domain";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documents } from "../schema/documents.js";
import { documentRetentionHolds, retentionPolicies } from "../schema/governance.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function toRetentionPolicyEntity(
  row: typeof retentionPolicies.$inferSelect,
): RetentionPolicyEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    categoryId: row.categoryId,
    name: row.name,
    retentionDays: row.retentionDays,
    trashGraceDays: row.trashGraceDays,
    actionOnExpiry: row.actionOnExpiry,
    isActive: row.isActive,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDocumentRetentionHoldEntity(
  row: typeof documentRetentionHolds.$inferSelect,
): DocumentRetentionHoldEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    documentId: row.documentId,
    reason: row.reason,
    placedByUserId: row.placedByUserId,
    placedAt: row.placedAt.toISOString(),
    releasedByUserId: row.releasedByUserId,
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
    releaseReason: row.releaseReason,
  };
}

/**
 * PostgreSQL repository for configurable organization/category retention policies.
 */
export function createRetentionPolicyRepository(db: NodePgDatabase): RetentionPolicyRepositoryPort {
  return {
    async listByOrganization(
      organizationId: string,
      tx?: TransactionContext,
    ): Promise<readonly RetentionPolicyEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select()
        .from(retentionPolicies)
        .where(eq(retentionPolicies.organizationId, organizationId))
        .orderBy(asc(retentionPolicies.name), asc(retentionPolicies.id));
      return rows.map(toRetentionPolicyEntity);
    },

    async findById(
      policyId: string,
      tx?: TransactionContext,
    ): Promise<RetentionPolicyEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(retentionPolicies)
        .where(eq(retentionPolicies.id, policyId))
        .limit(1);
      return row ? toRetentionPolicyEntity(row) : null;
    },

    async findByName(
      organizationId: string,
      name: string,
      tx?: TransactionContext,
    ): Promise<RetentionPolicyEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(retentionPolicies)
        .where(
          and(
            eq(retentionPolicies.organizationId, organizationId),
            eq(retentionPolicies.name, name),
          ),
        )
        .limit(1);
      return row ? toRetentionPolicyEntity(row) : null;
    },

    async findApplicablePolicy(
      organizationId: string,
      categoryId: string,
      tx?: TransactionContext,
    ): Promise<RetentionPolicyEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select()
        .from(retentionPolicies)
        .where(
          and(
            eq(retentionPolicies.organizationId, organizationId),
            eq(retentionPolicies.isActive, true),
            or(eq(retentionPolicies.categoryId, categoryId), isNull(retentionPolicies.categoryId)),
          ),
        )
        .orderBy(asc(retentionPolicies.createdAt), asc(retentionPolicies.id));

      const categorySpecific = rows.find((row) => row.categoryId === categoryId);
      const selected = categorySpecific ?? rows[0];
      return selected ? toRetentionPolicyEntity(selected) : null;
    },

    async create(
      input: CreateRetentionPolicyInput,
      tx?: TransactionContext,
    ): Promise<RetentionPolicyEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [inserted] = await executor
        .insert(retentionPolicies)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          categoryId: input.categoryId,
          name: input.name,
          retentionDays: input.retentionDays,
          trashGraceDays: input.trashGraceDays,
          actionOnExpiry: input.actionOnExpiry,
          isActive: input.isActive,
          createdBy: input.createdBy,
          updatedBy: input.createdBy,
        })
        .returning();
      if (!inserted) {
        throw new Error("Falha ao criar política de retenção.");
      }
      return toRetentionPolicyEntity(inserted);
    },

    async update(
      policyId: string,
      input: UpdateRetentionPolicyInput,
      tx?: TransactionContext,
    ): Promise<RetentionPolicyEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [updated] = await executor
        .update(retentionPolicies)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {}),
          ...(input.trashGraceDays !== undefined ? { trashGraceDays: input.trashGraceDays } : {}),
          ...(input.actionOnExpiry !== undefined ? { actionOnExpiry: input.actionOnExpiry } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedBy: input.updatedBy,
          updatedAt: new Date(),
        })
        .where(eq(retentionPolicies.id, policyId))
        .returning();
      return updated ? toRetentionPolicyEntity(updated) : null;
    },
  };
}

/**
 * PostgreSQL repository for document legal holds (`document_retention_holds`).
 */
export function createDocumentRetentionHoldRepository(
  db: NodePgDatabase,
): DocumentRetentionHoldRepositoryPort {
  return {
    async listForDocument(
      organizationId: string,
      documentId: string,
      tx?: TransactionContext,
    ): Promise<readonly DocumentRetentionHoldEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select()
        .from(documentRetentionHolds)
        .where(
          and(
            eq(documentRetentionHolds.organizationId, organizationId),
            eq(documentRetentionHolds.documentId, documentId),
          ),
        )
        .orderBy(desc(documentRetentionHolds.placedAt), desc(documentRetentionHolds.id));
      return rows.map(toDocumentRetentionHoldEntity);
    },

    async listActiveForDocument(
      organizationId: string,
      documentId: string,
      tx?: TransactionContext,
    ): Promise<readonly DocumentRetentionHoldEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select()
        .from(documentRetentionHolds)
        .where(
          and(
            eq(documentRetentionHolds.organizationId, organizationId),
            eq(documentRetentionHolds.documentId, documentId),
            isNull(documentRetentionHolds.releasedAt),
          ),
        )
        .orderBy(desc(documentRetentionHolds.placedAt), desc(documentRetentionHolds.id));
      return rows.map(toDocumentRetentionHoldEntity);
    },

    async findById(
      holdId: string,
      tx?: TransactionContext,
    ): Promise<DocumentRetentionHoldEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(documentRetentionHolds)
        .where(eq(documentRetentionHolds.id, holdId))
        .limit(1);
      return row ? toDocumentRetentionHoldEntity(row) : null;
    },

    async hasActiveHold(
      organizationId: string,
      documentId: string,
      tx?: TransactionContext,
    ): Promise<boolean> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({ id: documentRetentionHolds.id })
        .from(documentRetentionHolds)
        .where(
          and(
            eq(documentRetentionHolds.organizationId, organizationId),
            eq(documentRetentionHolds.documentId, documentId),
            isNull(documentRetentionHolds.releasedAt),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async findDocumentDeletedAt(
      organizationId: string,
      documentId: string,
      tx?: TransactionContext,
    ): Promise<Date | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(and(eq(documents.organizationId, organizationId), eq(documents.id, documentId)))
        .limit(1);
      return row?.deletedAt ?? null;
    },

    async createHold(
      input: CreateDocumentRetentionHoldInput,
      tx?: TransactionContext,
    ): Promise<DocumentRetentionHoldEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [inserted] = await executor
        .insert(documentRetentionHolds)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          documentId: input.documentId,
          reason: input.reason,
          placedByUserId: input.placedByUserId,
          placedAt: input.placedAt,
        })
        .returning();
      if (!inserted) {
        throw new Error("Falha ao registrar bloqueio de retenção (hold).");
      }
      return toDocumentRetentionHoldEntity(inserted);
    },

    async releaseHold(
      input: ReleaseDocumentRetentionHoldInput,
      tx?: TransactionContext,
    ): Promise<DocumentRetentionHoldEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [updated] = await executor
        .update(documentRetentionHolds)
        .set({
          releasedByUserId: input.releasedByUserId,
          releasedAt: input.releasedAt,
          releaseReason: input.releaseReason,
        })
        .where(
          and(
            eq(documentRetentionHolds.organizationId, input.organizationId),
            eq(documentRetentionHolds.documentId, input.documentId),
            eq(documentRetentionHolds.id, input.holdId),
            isNull(documentRetentionHolds.releasedAt),
          ),
        )
        .returning();
      return updated ? toDocumentRetentionHoldEntity(updated) : null;
    },
  };
}
