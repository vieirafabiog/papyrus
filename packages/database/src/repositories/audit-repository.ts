import type {
  AuditActorSummary,
  AuditEventInput,
  AuditEventRecord,
  AuditExportFilter,
  AuditFacetsRecord,
  AuditListFilter,
  AuditMetadataValue,
  AuditRepositoryPort,
  AuditSortField,
  PaginatedResult,
  TransactionContext,
} from "@docuflow/domain";
import { type SQL, and, asc, count, desc, eq, gte, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type AuditMetadataJson, auditEvents } from "../schema/governance.js";
import { users } from "../schema/identity.js";
import { resolveDbExecutor } from "./transaction-manager.js";

interface AuditJoinedRow {
  readonly event: typeof auditEvents.$inferSelect;
  readonly actorName: string | null;
  readonly actorEmail: string | null;
}

function toAuditEventRecord(
  row: typeof auditEvents.$inferSelect,
  actorName: string | null = null,
  actorEmail: string | null = null,
): AuditEventRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    actorName,
    actorEmail,
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

function buildAuditWhereConditions(filter: Omit<AuditListFilter, "page" | "pageSize">): SQL {
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
  if (filter.resourceId !== undefined) {
    conditions.push(eq(auditEvents.resourceId, filter.resourceId));
  }
  if (filter.result !== undefined) {
    conditions.push(eq(auditEvents.result, filter.result));
  }
  if (filter.occurredFrom !== undefined) {
    conditions.push(gte(auditEvents.occurredAt, filter.occurredFrom));
  }
  if (filter.occurredTo !== undefined) {
    conditions.push(lte(auditEvents.occurredAt, filter.occurredTo));
  }

  const clause = and(...conditions);
  if (!clause) {
    throw new Error("Audit query filter must include organizationId.");
  }
  return clause;
}

function resolveAuditOrderColumns(
  sortBy: AuditSortField | undefined,
  sortDirection: "asc" | "desc" | undefined,
): readonly SQL[] {
  const isAsc = sortDirection === "asc";
  const dir = isAsc ? asc : desc;
  const secondaryId = dir(auditEvents.id);

  switch (sortBy ?? "occurredAt") {
    case "action":
      return [dir(auditEvents.action), desc(auditEvents.occurredAt), secondaryId];
    case "resourceType":
      return [dir(auditEvents.resourceType), desc(auditEvents.occurredAt), secondaryId];
    case "result":
      return [dir(auditEvents.result), desc(auditEvents.occurredAt), secondaryId];
    default:
      return [dir(auditEvents.occurredAt), secondaryId];
  }
}

async function queryAuditRows(
  db: NodePgDatabase,
  whereClause: SQL,
  sortBy: AuditSortField | undefined,
  sortDirection: "asc" | "desc" | undefined,
  limit: number,
  offset: number,
): Promise<readonly AuditEventRecord[]> {
  const rows: AuditJoinedRow[] = await db
    .select({
      event: auditEvents,
      actorName: users.fullName,
      actorEmail: users.email,
    })
    .from(auditEvents)
    .leftJoin(
      users,
      and(
        eq(auditEvents.actorUserId, users.id),
        eq(users.organizationId, auditEvents.organizationId),
      ),
    )
    .where(whereClause)
    .orderBy(...resolveAuditOrderColumns(sortBy, sortDirection))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => toAuditEventRecord(row.event, row.actorName, row.actorEmail));
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
      const whereClause = buildAuditWhereConditions(filter);
      const offset = (filter.page - 1) * filter.pageSize;

      const [countRow] = await db.select({ total: count() }).from(auditEvents).where(whereClause);
      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);

      const items = await queryAuditRows(
        db,
        whereClause,
        filter.sortBy,
        filter.sortDirection,
        filter.pageSize,
        offset,
      );

      return {
        items,
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages,
      };
    },

    async listForExport(filter: AuditExportFilter): Promise<readonly AuditEventRecord[]> {
      const whereClause = buildAuditWhereConditions(filter);
      return queryAuditRows(db, whereClause, filter.sortBy, filter.sortDirection, filter.limit, 0);
    },

    async listFacets(organizationId: string): Promise<AuditFacetsRecord> {
      const [actionRows, resourceRows, userRows] = await Promise.all([
        db
          .selectDistinct({ action: auditEvents.action })
          .from(auditEvents)
          .where(eq(auditEvents.organizationId, organizationId))
          .orderBy(asc(auditEvents.action)),
        db
          .selectDistinct({ resourceType: auditEvents.resourceType })
          .from(auditEvents)
          .where(eq(auditEvents.organizationId, organizationId))
          .orderBy(asc(auditEvents.resourceType)),
        db
          .select({
            id: users.id,
            fullName: users.fullName,
            email: users.email,
          })
          .from(users)
          .where(eq(users.organizationId, organizationId))
          .orderBy(asc(users.fullName), asc(users.email)),
      ]);

      const actors: readonly AuditActorSummary[] = userRows.map((row) => ({
        id: row.id,
        fullName: row.fullName,
        email: row.email,
      }));

      return {
        actors,
        actions: actionRows.map((row) => row.action),
        resourceTypes: resourceRows.map((row) => row.resourceType),
      };
    },
  };
}
