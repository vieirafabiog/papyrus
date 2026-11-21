import type {
  AuditEventInput,
  AuditEventRecord,
  AuditListFilter,
  AuditMetadataValue,
  AuditRepositoryPort,
  PaginatedResult,
  TransactionContext,
} from "@docuflow/domain";
import { type SQL, and, count, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type AuditMetadataJson, auditEvents } from "../schema/governance.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function toAuditEventRecord(row: typeof auditEvents.$inferSelect): AuditEventRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    result: row.result,
    requestId: row.requestId,
    ipAddress: row.ipAddress,
    metadata: row.metadata,
  };
}

function toMutableAuditMetadata(
  metadata: Readonly<Record<string, AuditMetadataValue>> | undefined,
): AuditMetadataJson {
  const result: AuditMetadataJson = {};
  if (!metadata) {
    return result;
  }
  for (const [key, value] of Object.entries(metadata)) {
    result[key] = value;
  }
  return result;
}

export function createAuditRepository(db: NodePgDatabase): AuditRepositoryPort {
  return {
    async append(event: AuditEventInput, tx?: TransactionContext): Promise<AuditEventRecord> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(auditEvents)
        .values({
          organizationId: event.organizationId,
          actorUserId: event.actorUserId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          result: event.result,
          requestId: event.requestId,
          ...(event.ipAddress !== undefined ? { ipAddress: event.ipAddress } : {}),
          metadata: toMutableAuditMetadata(event.metadata),
        })
        .returning();

      if (!row) {
        throw new Error("Failed to append audit event.");
      }
      return toAuditEventRecord(row);
    },

    async list(filter: AuditListFilter): Promise<PaginatedResult<AuditEventRecord>> {
      const conditions: SQL[] = [eq(auditEvents.organizationId, filter.organizationId)];

      if (filter.actorUserId !== undefined) {
        conditions.push(eq(auditEvents.actorUserId, filter.actorUserId));
      }
      if (filter.action !== undefined) {
        conditions.push(eq(auditEvents.action, filter.action));
      }
      if (filter.resourceType !== undefined) {
        conditions.push(eq(auditEvents.resourceType, filter.resourceType));
      }

      const whereClause = and(...conditions);
      const offset = (filter.page - 1) * filter.pageSize;

      const [countRow] = await db.select({ total: count() }).from(auditEvents).where(whereClause);
      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);

      const rows = await db
        .select()
        .from(auditEvents)
        .where(whereClause)
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
        .limit(filter.pageSize)
        .offset(offset);

      return {
        items: rows.map(toAuditEventRecord),
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages,
      };
    },
  };
}
