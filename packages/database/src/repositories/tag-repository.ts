import type {
  AttachDocumentTagRecordInput,
  CreateTagRecordInput,
  PaginatedResult,
  TagEntity,
  TagListFilter,
  TagRepositoryPort,
  TagSortField,
  TransactionContext,
} from "@docuflow/domain";
import { type SQL, and, asc, count, desc, eq, ilike, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documentTags } from "../schema/documents.js";
import { tags } from "../schema/taxonomy.js";
import { resolveDbExecutor } from "./transaction-manager.js";

const ALLOWED_TAG_SORT_COLUMNS: Readonly<
  Record<TagSortField, typeof tags.name | typeof tags.createdAt | typeof tags.id>
> = {
  name: tags.name,
  createdAt: tags.createdAt,
  id: tags.id,
};

function toTagEntity(row: typeof tags.$inferSelect): TagEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    normalizedName: row.normalizedName,
    color: row.color,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Creates the Drizzle ORM repository for organization tags and document-tag links.
 */
export function createTagRepository(db: NodePgDatabase): TagRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<TagEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor.select().from(tags).where(eq(tags.id, id)).limit(1);
      return row ? toTagEntity(row) : null;
    },

    async findByNormalizedName(
      organizationId: string,
      normalizedName: string,
      tx?: TransactionContext,
    ): Promise<TagEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(tags)
        .where(
          and(eq(tags.organizationId, organizationId), eq(tags.normalizedName, normalizedName)),
        )
        .limit(1);
      return row ? toTagEntity(row) : null;
    },

    async list(filter: TagListFilter): Promise<PaginatedResult<TagEntity>> {
      const conditions: SQL[] = [eq(tags.organizationId, filter.organizationId)];

      if (filter.search !== undefined && filter.search.trim().length > 0) {
        const pattern = `%${filter.search.trim()}%`;
        const searchCondition = or(ilike(tags.name, pattern), ilike(tags.normalizedName, pattern));
        if (searchCondition) {
          conditions.push(searchCondition);
        }
      }

      const whereClause = and(...conditions);
      const sortColumn = ALLOWED_TAG_SORT_COLUMNS[filter.sortBy];
      const primaryOrder = filter.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
      const tiebreakerOrder = filter.sortDirection === "asc" ? asc(tags.id) : desc(tags.id);
      const offset = (filter.page - 1) * filter.pageSize;

      const [countRow] = await db.select({ total: count() }).from(tags).where(whereClause);
      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);

      const rows = await db
        .select()
        .from(tags)
        .where(whereClause)
        .orderBy(primaryOrder, tiebreakerOrder)
        .limit(filter.pageSize)
        .offset(offset);

      return {
        items: rows.map(toTagEntity),
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages,
      };
    },

    async create(input: CreateTagRecordInput, tx?: TransactionContext): Promise<TagEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(tags)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          name: input.name,
          normalizedName: input.normalizedName,
          color: input.color,
          createdBy: input.createdBy,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to insert tag record.");
      }
      return toTagEntity(row);
    },

    async listDocumentTags(
      organizationId: string,
      documentId: string,
      tx?: TransactionContext,
    ): Promise<readonly TagEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select({ tag: tags })
        .from(documentTags)
        .innerJoin(tags, eq(documentTags.tagId, tags.id))
        .where(
          and(eq(documentTags.documentId, documentId), eq(tags.organizationId, organizationId)),
        )
        .orderBy(asc(tags.name), asc(tags.id));

      return rows.map((row) => toTagEntity(row.tag));
    },

    async isAttachedToDocument(
      documentId: string,
      tagId: string,
      tx?: TransactionContext,
    ): Promise<boolean> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({ total: count() })
        .from(documentTags)
        .where(and(eq(documentTags.documentId, documentId), eq(documentTags.tagId, tagId)));
      return Number(row?.total ?? 0) > 0;
    },

    async attachToDocument(
      input: AttachDocumentTagRecordInput,
      tx?: TransactionContext,
    ): Promise<void> {
      const executor = resolveDbExecutor(db, tx);
      await executor.insert(documentTags).values({
        id: input.id,
        documentId: input.documentId,
        tagId: input.tagId,
        createdBy: input.createdBy,
      });
    },

    async detachFromDocument(
      documentId: string,
      tagId: string,
      tx?: TransactionContext,
    ): Promise<boolean> {
      const executor = resolveDbExecutor(db, tx);
      const deletedRows = await executor
        .delete(documentTags)
        .where(and(eq(documentTags.documentId, documentId), eq(documentTags.tagId, tagId)))
        .returning({ id: documentTags.id });
      return deletedRows.length > 0;
    },
  };
}
