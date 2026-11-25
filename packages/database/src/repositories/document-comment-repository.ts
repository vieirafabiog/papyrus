import type {
  CreateDocumentCommentRecordInput,
  DocumentCommentEntity,
  DocumentCommentMentionEntity,
  DocumentCommentParticipantEntity,
  DocumentCommentRepositoryPort,
  PaginatedResult,
  TransactionContext,
} from "@papyrus/domain";
import { and, asc, count, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documentCommentMentions, documentComments } from "../schema/documents.js";
import { users } from "../schema/identity.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * PostgreSQL Drizzle repository for document comments, same-tenant @mentions,
 * and active mention candidate lookup.
 */
export function createDocumentCommentRepository(db: NodePgDatabase): DocumentCommentRepositoryPort {
  async function loadMentionsMap(
    commentIds: readonly string[],
    tx?: TransactionContext,
  ): Promise<ReadonlyMap<string, readonly DocumentCommentMentionEntity[]>> {
    const result = new Map<string, DocumentCommentMentionEntity[]>();
    if (commentIds.length === 0) {
      return result;
    }

    const executor = resolveDbExecutor(db, tx);
    const rows = await executor
      .select({
        commentId: documentCommentMentions.commentId,
        userId: users.id,
        fullName: users.fullName,
        email: users.email,
      })
      .from(documentCommentMentions)
      .innerJoin(users, eq(documentCommentMentions.mentionedUserId, users.id))
      .where(inArray(documentCommentMentions.commentId, [...commentIds]))
      .orderBy(asc(users.fullName), asc(users.id));

    for (const row of rows) {
      const list = result.get(row.commentId) ?? [];
      list.push({
        userId: row.userId,
        fullName: row.fullName,
        email: row.email,
      });
      result.set(row.commentId, list);
    }

    return result;
  }

  return {
    async listByDocument(input, tx): Promise<PaginatedResult<DocumentCommentEntity>> {
      const executor = resolveDbExecutor(db, tx);
      const whereClause = and(
        eq(documentComments.organizationId, input.organizationId),
        eq(documentComments.documentId, input.documentId),
        isNull(documentComments.deletedAt),
      );

      const [countRow] = await executor
        .select({ total: count(documentComments.id) })
        .from(documentComments)
        .where(whereClause);

      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = Math.max(1, Math.ceil(totalItems / input.pageSize));
      const offset = (input.page - 1) * input.pageSize;

      const rows = await executor
        .select({
          id: documentComments.id,
          organizationId: documentComments.organizationId,
          documentId: documentComments.documentId,
          body: documentComments.body,
          deletedAt: documentComments.deletedAt,
          createdAt: documentComments.createdAt,
          updatedAt: documentComments.updatedAt,
          authorId: users.id,
          authorFullName: users.fullName,
          authorEmail: users.email,
        })
        .from(documentComments)
        .innerJoin(users, eq(documentComments.authorUserId, users.id))
        .where(whereClause)
        .orderBy(asc(documentComments.createdAt), asc(documentComments.id))
        .limit(input.pageSize)
        .offset(offset);

      const mentionsMap = await loadMentionsMap(
        rows.map((row) => row.id),
        tx,
      );

      return {
        items: rows.map((row) => ({
          id: row.id,
          organizationId: row.organizationId,
          documentId: row.documentId,
          author: {
            id: row.authorId,
            fullName: row.authorFullName,
            email: row.authorEmail,
          },
          body: row.body,
          mentions: mentionsMap.get(row.id) ?? [],
          deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        page: input.page,
        pageSize: input.pageSize,
        totalItems,
        totalPages,
      };
    },

    async findById(id: string, tx?: TransactionContext): Promise<DocumentCommentEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({
          id: documentComments.id,
          organizationId: documentComments.organizationId,
          documentId: documentComments.documentId,
          body: documentComments.body,
          deletedAt: documentComments.deletedAt,
          createdAt: documentComments.createdAt,
          updatedAt: documentComments.updatedAt,
          authorId: users.id,
          authorFullName: users.fullName,
          authorEmail: users.email,
        })
        .from(documentComments)
        .innerJoin(users, eq(documentComments.authorUserId, users.id))
        .where(eq(documentComments.id, id))
        .limit(1);

      if (!row) {
        return null;
      }

      const mentionsMap = await loadMentionsMap([row.id], tx);

      return {
        id: row.id,
        organizationId: row.organizationId,
        documentId: row.documentId,
        author: {
          id: row.authorId,
          fullName: row.authorFullName,
          email: row.authorEmail,
        },
        body: row.body,
        mentions: mentionsMap.get(row.id) ?? [],
        deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    },

    async create(
      input: CreateDocumentCommentRecordInput,
      tx?: TransactionContext,
    ): Promise<DocumentCommentEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [inserted] = await executor
        .insert(documentComments)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          documentId: input.documentId,
          authorUserId: input.authorUserId,
          body: input.body,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })
        .returning();

      if (!inserted) {
        throw new Error("Failed to insert document comment.");
      }

      if (input.mentionedUserIds.length > 0) {
        await executor
          .insert(documentCommentMentions)
          .values(
            input.mentionedUserIds.map((mentionedUserId) => ({
              organizationId: input.organizationId,
              commentId: inserted.id,
              mentionedUserId,
              createdAt: input.createdAt,
            })),
          )
          .onConflictDoNothing();
      }

      const created = await this.findById(inserted.id, tx);
      if (!created) {
        throw new Error("Failed to load inserted document comment.");
      }
      return created;
    },

    async softDelete(
      input: { readonly id: string; readonly deletedAt: Date },
      tx?: TransactionContext,
    ): Promise<boolean> {
      const executor = resolveDbExecutor(db, tx);
      const updated = await executor
        .update(documentComments)
        .set({
          deletedAt: input.deletedAt,
          updatedAt: input.deletedAt,
        })
        .where(and(eq(documentComments.id, input.id), isNull(documentComments.deletedAt)))
        .returning({ id: documentComments.id });
      return updated.length > 0;
    },

    async filterActiveOrganizationUsers(
      input: { readonly organizationId: string; readonly userIds: readonly string[] },
      tx?: TransactionContext,
    ): Promise<readonly DocumentCommentParticipantEntity[]> {
      if (input.userIds.length === 0) {
        return [];
      }
      const executor = resolveDbExecutor(db, tx);
      return executor
        .select({
          id: users.id,
          fullName: users.fullName,
          email: users.email,
        })
        .from(users)
        .where(
          and(
            eq(users.organizationId, input.organizationId),
            eq(users.status, "ACTIVE"),
            inArray(users.id, [...input.userIds]),
          ),
        )
        .orderBy(asc(users.fullName), asc(users.id));
    },

    async listActiveMentionCandidates(
      input: {
        readonly organizationId: string;
        readonly query?: string | undefined;
        readonly limit: number;
      },
      tx?: TransactionContext,
    ): Promise<readonly DocumentCommentParticipantEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const trimmed = input.query?.trim() ?? "";
      const pattern = trimmed.length > 0 ? `%${escapeLikePattern(trimmed)}%` : null;

      return executor
        .select({
          id: users.id,
          fullName: users.fullName,
          email: users.email,
        })
        .from(users)
        .where(
          pattern
            ? and(
                eq(users.organizationId, input.organizationId),
                eq(users.status, "ACTIVE"),
                or(ilike(users.fullName, pattern), ilike(users.email, pattern)),
              )
            : and(eq(users.organizationId, input.organizationId), eq(users.status, "ACTIVE")),
        )
        .orderBy(asc(users.fullName), asc(users.id))
        .limit(input.limit);
    },
  };
}
