import type {
  CreateDocumentInput,
  CreateDocumentVersionInput,
  DocumentEntity,
  DocumentListFilter,
  DocumentMetadataMap,
  DocumentRepositoryPort,
  DocumentSortField,
  DocumentStatus,
  DocumentVersionEntity,
  DocumentVersionRepositoryPort,
  PaginatedResult,
  TransactionContext,
  UpdateDocumentInput,
} from "@docuflow/domain";
import { type SQL, and, asc, count, desc, eq, ilike, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  type DocumentMetadataColumnValue,
  documentVersions,
  documents,
} from "../schema/documents.js";
import { resolveDbExecutor } from "./transaction-manager.js";

const ALLOWED_DOCUMENT_SORT_COLUMNS: Readonly<
  Record<
    DocumentSortField,
    | typeof documents.title
    | typeof documents.status
    | typeof documents.issueDate
    | typeof documents.expirationDate
    | typeof documents.createdAt
    | typeof documents.updatedAt
    | typeof documents.id
  >
> = {
  title: documents.title,
  status: documents.status,
  issueDate: documents.issueDate,
  expirationDate: documents.expirationDate,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  id: documents.id,
};

function toDocumentEntity(row: typeof documents.$inferSelect): DocumentEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    categoryId: row.categoryId,
    folderId: row.folderId,
    status: row.status,
    currentVersionId: row.currentVersionId,
    ownerUserId: row.ownerUserId,
    issueDate: row.issueDate,
    expirationDate: row.expirationDate,
    metadata: row.metadata as DocumentMetadataMap,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDocumentVersionEntity(row: typeof documentVersions.$inferSelect): DocumentVersionEntity {
  return {
    id: row.id,
    documentId: row.documentId,
    versionNumber: row.versionNumber,
    fileObjectId: row.fileObjectId,
    uploadedByUserId: row.uploadedByUserId,
    changeNote: row.changeNote,
    createdAt: row.createdAt.toISOString(),
  };
}

function toMutableMetadataRecord(
  metadata: DocumentMetadataMap,
): Record<string, DocumentMetadataColumnValue> {
  const result: Record<string, DocumentMetadataColumnValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    result[key] = typeof value === "object" && value !== null ? [...value] : value;
  }
  return result;
}

export function createDocumentRepository(db: NodePgDatabase): DocumentRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<DocumentEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor.select().from(documents).where(eq(documents.id, id)).limit(1);
      return row ? toDocumentEntity(row) : null;
    },

    async list(filter: DocumentListFilter): Promise<PaginatedResult<DocumentEntity>> {
      const conditions: SQL[] = [eq(documents.organizationId, filter.organizationId)];

      if (filter.status !== undefined) {
        conditions.push(eq(documents.status, filter.status));
      } else {
        conditions.push(ne(documents.status, "DELETED"));
      }
      if (filter.categoryId !== undefined) {
        conditions.push(eq(documents.categoryId, filter.categoryId));
      }
      if (filter.folderId !== undefined) {
        conditions.push(eq(documents.folderId, filter.folderId));
      }
      if (filter.search !== undefined && filter.search.trim().length > 0) {
        conditions.push(ilike(documents.title, `%${filter.search.trim()}%`));
      }

      const whereClause = and(...conditions);
      const sortColumn = ALLOWED_DOCUMENT_SORT_COLUMNS[filter.sortBy];
      const primaryOrder = filter.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
      const tiebreakerOrder =
        filter.sortDirection === "asc" ? asc(documents.id) : desc(documents.id);

      const offset = (filter.page - 1) * filter.pageSize;

      const [countRow] = await db.select({ total: count() }).from(documents).where(whereClause);
      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);

      const rows = await db
        .select()
        .from(documents)
        .where(whereClause)
        .orderBy(primaryOrder, tiebreakerOrder)
        .limit(filter.pageSize)
        .offset(offset);

      return {
        items: rows.map(toDocumentEntity),
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages,
      };
    },

    async create(input: CreateDocumentInput, tx?: TransactionContext): Promise<DocumentEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(documents)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          title: input.title,
          categoryId: input.categoryId,
          folderId: input.folderId,
          ownerUserId: input.ownerUserId,
          issueDate: input.issueDate,
          expirationDate: input.expirationDate,
          metadata: toMutableMetadataRecord(input.metadata),
          createdBy: input.ownerUserId,
          updatedBy: input.ownerUserId,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to insert document record.");
      }
      return toDocumentEntity(row);
    },

    async updateWithOptimisticLock(
      id: string,
      expectedVersion: number,
      input: UpdateDocumentInput,
      tx?: TransactionContext,
    ): Promise<DocumentEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const patch: Partial<typeof documents.$inferInsert> = {
        version: expectedVersion + 1,
        updatedAt: new Date(),
      };
      if (input.title !== undefined) {
        patch.title = input.title;
      }
      if (input.categoryId !== undefined) {
        patch.categoryId = input.categoryId;
      }
      if (input.folderId !== undefined) {
        patch.folderId = input.folderId;
      }
      if (input.issueDate !== undefined) {
        patch.issueDate = input.issueDate;
      }
      if (input.expirationDate !== undefined) {
        patch.expirationDate = input.expirationDate;
      }
      if (input.metadata !== undefined) {
        patch.metadata = toMutableMetadataRecord(input.metadata);
      }

      const [row] = await executor
        .update(documents)
        .set(patch)
        .where(and(eq(documents.id, id), eq(documents.version, expectedVersion)))
        .returning();

      return row ? toDocumentEntity(row) : null;
    },

    async setCurrentVersion(
      documentId: string,
      versionId: string,
      expectedVersion: number,
      tx?: TransactionContext,
    ): Promise<DocumentEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .update(documents)
        .set({
          currentVersionId: versionId,
          version: expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, documentId), eq(documents.version, expectedVersion)))
        .returning();

      return row ? toDocumentEntity(row) : null;
    },

    async updateStatus(
      documentId: string,
      status: DocumentStatus,
      expectedVersion: number,
      tx?: TransactionContext,
    ): Promise<DocumentEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .update(documents)
        .set({
          status,
          deletedAt: status === "DELETED" ? new Date() : null,
          version: expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, documentId), eq(documents.version, expectedVersion)))
        .returning();

      return row ? toDocumentEntity(row) : null;
    },
  };
}

export function createDocumentVersionRepository(db: NodePgDatabase): DocumentVersionRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<DocumentVersionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.id, id))
        .limit(1);
      return row ? toDocumentVersionEntity(row) : null;
    },

    async findByFileObjectId(
      fileObjectId: string,
      tx?: TransactionContext,
    ): Promise<DocumentVersionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.fileObjectId, fileObjectId))
        .limit(1);
      return row ? toDocumentVersionEntity(row) : null;
    },

    async findLatestByDocumentId(
      documentId: string,
      tx?: TransactionContext,
    ): Promise<DocumentVersionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, documentId))
        .orderBy(desc(documentVersions.versionNumber))
        .limit(1);
      return row ? toDocumentVersionEntity(row) : null;
    },

    async listByDocumentId(
      documentId: string,
      tx?: TransactionContext,
    ): Promise<readonly DocumentVersionEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, documentId))
        .orderBy(desc(documentVersions.versionNumber));
      return rows.map(toDocumentVersionEntity);
    },

    async create(
      input: CreateDocumentVersionInput,
      tx?: TransactionContext,
    ): Promise<DocumentVersionEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(documentVersions)
        .values({
          id: input.id,
          documentId: input.documentId,
          versionNumber: input.versionNumber,
          fileObjectId: input.fileObjectId,
          uploadedByUserId: input.uploadedByUserId,
          changeNote: input.changeNote,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to insert document version record.");
      }
      return toDocumentVersionEntity(row);
    },
  };
}
