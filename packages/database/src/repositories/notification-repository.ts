import type { TransactionContext } from "@docuflow/domain";
import type {
  CreateInAppNotificationRecordInput,
  InAppNotificationEventKind,
  InAppNotificationRecord,
  InAppNotificationRepositoryPort,
  InsertIdempotentInAppNotificationResult,
  ListInAppNotificationsQuery,
  ListInAppNotificationsResult,
  MarkInAppNotificationReadOutcome,
} from "@docuflow/notifications";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { notifications } from "../schema/workflows.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function toInAppNotificationRecord(
  row: typeof notifications.$inferSelect,
): InAppNotificationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    recipientUserId: row.recipientUserId,
    channel: "INTERNAL",
    kind: row.kind as InAppNotificationEventKind,
    idempotencyKey: row.idempotencyKey,
    title: row.title,
    body: row.body,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    readAt: row.readAt,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
  };
}

/**
 * Creates a PostgreSQL-backed internal notification repository enforcing unique
 * idempotency keys, recipient scoping, and atomic single-notification read updates.
 */
export function createInAppNotificationRepository(
  db: NodePgDatabase,
): InAppNotificationRepositoryPort {
  return {
    async insertIdempotent(
      input: CreateInAppNotificationRecordInput,
      tx?: unknown,
    ): Promise<InsertIdempotentInAppNotificationResult> {
      const executor = resolveDbExecutor(db, tx as TransactionContext | undefined);

      const [inserted] = await executor
        .insert(notifications)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          recipientUserId: input.recipientUserId,
          channel: "INTERNAL",
          kind: input.kind,
          idempotencyKey: input.idempotencyKey,
          title: input.title,
          body: input.body,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          sentAt: input.sentAt,
        })
        .onConflictDoNothing({
          target: [
            notifications.organizationId,
            notifications.channel,
            notifications.recipientUserId,
            notifications.idempotencyKey,
          ],
        })
        .returning();

      if (inserted) {
        return {
          notification: toInAppNotificationRecord(inserted),
          created: true,
        };
      }

      const [existing] = await executor
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.organizationId, input.organizationId),
            eq(notifications.channel, "INTERNAL"),
            eq(notifications.recipientUserId, input.recipientUserId),
            eq(notifications.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new Error("Failed to insert or retrieve deduplicated internal notification.");
      }

      return {
        notification: toInAppNotificationRecord(existing),
        created: false,
      };
    },

    async listForRecipient(
      query: ListInAppNotificationsQuery,
    ): Promise<ListInAppNotificationsResult> {
      const baseConditions = [
        eq(notifications.organizationId, query.organizationId),
        eq(notifications.recipientUserId, query.recipientUserId),
        eq(notifications.channel, "INTERNAL"),
      ];

      const listConditions = [...baseConditions];
      if (query.unreadOnly) {
        listConditions.push(isNull(notifications.readAt));
      }
      if (query.kind) {
        listConditions.push(eq(notifications.kind, query.kind));
      }

      const offset = (query.page - 1) * query.pageSize;

      const [totalRow] = await db
        .select({ value: count() })
        .from(notifications)
        .where(and(...listConditions));
      const [unreadRow] = await db
        .select({ value: count() })
        .from(notifications)
        .where(and(...baseConditions, isNull(notifications.readAt)));

      const rows = await db
        .select()
        .from(notifications)
        .where(and(...listConditions))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.pageSize)
        .offset(offset);

      const totalItems = Number(totalRow?.value ?? 0);
      const unreadCount = Number(unreadRow?.value ?? 0);

      return {
        items: rows.map(toInAppNotificationRecord),
        unreadCount,
        totalItems,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / query.pageSize),
      };
    },

    async markReadById(input: {
      readonly organizationId: string;
      readonly notificationId: string;
      readonly recipientUserId: string;
      readonly readAt: Date;
    }): Promise<MarkInAppNotificationReadOutcome> {
      const [existing] = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.organizationId, input.organizationId),
            eq(notifications.channel, "INTERNAL"),
          ),
        )
        .limit(1);

      if (!existing) {
        return { status: "NOT_FOUND" };
      }

      if (existing.recipientUserId !== input.recipientUserId) {
        return { status: "FORBIDDEN" };
      }

      if (existing.readAt !== null) {
        return {
          status: "UPDATED",
          notification: toInAppNotificationRecord(existing),
          alreadyRead: true,
        };
      }

      const [updated] = await db
        .update(notifications)
        .set({ readAt: input.readAt })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.organizationId, input.organizationId),
            eq(notifications.recipientUserId, input.recipientUserId),
            isNull(notifications.readAt),
          ),
        )
        .returning();

      if (updated) {
        return {
          status: "UPDATED",
          notification: toInAppNotificationRecord(updated),
          alreadyRead: false,
        };
      }

      // Concurrent read won the race: re-read authoritative row for idempotent response.
      const [current] = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.organizationId, input.organizationId),
            eq(notifications.recipientUserId, input.recipientUserId),
          ),
        )
        .limit(1);

      if (!current) {
        return { status: "NOT_FOUND" };
      }

      return {
        status: "UPDATED",
        notification: toInAppNotificationRecord(current),
        alreadyRead: true,
      };
    },
  };
}
