import type {
  CreateDocumentShareLinkRecordInput,
  DocumentShareLinkEntity,
  DocumentShareLinkRepositoryPort,
  TransactionContext,
} from "@papyrus/domain";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documentShareLinks } from "../schema/documents.js";
import { users } from "../schema/identity.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function toShareLinkEntity(
  row: typeof documentShareLinks.$inferSelect,
  creatorFullName: string,
): DocumentShareLinkEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    tokenHash: row.tokenHash,
    label: row.label,
    allowDownload: row.allowDownload,
    passcodeHash: row.passcodeHash,
    maxUses: row.maxUses,
    useCount: row.useCount,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokedByUserId: row.revokedByUserId,
    lastAccessedAt: row.lastAccessedAt ? row.lastAccessedAt.toISOString() : null,
    createdBy: {
      id: row.createdByUserId,
      fullName: creatorFullName,
    },
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * PostgreSQL Drizzle repository for temporary document share links with
 * HMAC-hashed lookup and race-free atomic access counter enforcement.
 */
export function createDocumentShareLinkRepository(
  db: NodePgDatabase,
): DocumentShareLinkRepositoryPort {
  async function loadWithCreatorById(
    id: string,
    tx?: TransactionContext,
  ): Promise<DocumentShareLinkEntity | null> {
    const executor = resolveDbExecutor(db, tx);
    const [row] = await executor
      .select({
        link: documentShareLinks,
        creatorName: users.fullName,
      })
      .from(documentShareLinks)
      .innerJoin(users, eq(documentShareLinks.createdByUserId, users.id))
      .where(eq(documentShareLinks.id, id))
      .limit(1);

    if (!row) {
      return null;
    }
    return toShareLinkEntity(row.link, row.creatorName);
  }

  return {
    async create(
      input: CreateDocumentShareLinkRecordInput,
      tx?: TransactionContext,
    ): Promise<DocumentShareLinkEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [inserted] = await executor
        .insert(documentShareLinks)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          tokenHash: input.tokenHash,
          label: input.label,
          allowDownload: input.allowDownload,
          passcodeHash: input.passcodeHash,
          maxUses: input.maxUses,
          useCount: 0,
          expiresAt: input.expiresAt,
          createdByUserId: input.createdByUserId,
          createdAt: input.createdAt,
        })
        .returning();

      if (!inserted) {
        throw new Error("Failed to insert document share link.");
      }

      const loaded = await loadWithCreatorById(inserted.id, tx);
      if (!loaded) {
        throw new Error("Failed to load inserted document share link.");
      }
      return loaded;
    },

    async listByDocument(
      input: { readonly organizationId: string; readonly documentId: string },
      tx?: TransactionContext,
    ): Promise<readonly DocumentShareLinkEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select({
          link: documentShareLinks,
          creatorName: users.fullName,
        })
        .from(documentShareLinks)
        .innerJoin(users, eq(documentShareLinks.createdByUserId, users.id))
        .where(
          and(
            eq(documentShareLinks.organizationId, input.organizationId),
            eq(documentShareLinks.documentId, input.documentId),
          ),
        )
        .orderBy(desc(documentShareLinks.createdAt), desc(documentShareLinks.id));

      return rows.map((row) => toShareLinkEntity(row.link, row.creatorName));
    },

    async findById(id: string, tx?: TransactionContext): Promise<DocumentShareLinkEntity | null> {
      return loadWithCreatorById(id, tx);
    },

    async findByTokenHash(
      tokenHash: string,
      tx?: TransactionContext,
    ): Promise<DocumentShareLinkEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({
          link: documentShareLinks,
          creatorName: users.fullName,
        })
        .from(documentShareLinks)
        .innerJoin(users, eq(documentShareLinks.createdByUserId, users.id))
        .where(eq(documentShareLinks.tokenHash, tokenHash))
        .limit(1);

      if (!row) {
        return null;
      }
      return toShareLinkEntity(row.link, row.creatorName);
    },

    async revokeById(
      input: { readonly id: string; readonly revokedByUserId: string; readonly revokedAt: Date },
      tx?: TransactionContext,
    ): Promise<DocumentShareLinkEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [updated] = await executor
        .update(documentShareLinks)
        .set({
          revokedAt: input.revokedAt,
          revokedByUserId: input.revokedByUserId,
        })
        .where(and(eq(documentShareLinks.id, input.id), isNull(documentShareLinks.revokedAt)))
        .returning({ id: documentShareLinks.id });

      if (!updated) {
        return loadWithCreatorById(input.id, tx);
      }
      return loadWithCreatorById(updated.id, tx);
    },

    async consumeUseAtomically(
      input: { readonly id: string; readonly now: Date },
      tx?: TransactionContext,
    ): Promise<DocumentShareLinkEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [updated] = await executor
        .update(documentShareLinks)
        .set({
          useCount: sql`${documentShareLinks.useCount} + 1`,
          lastAccessedAt: input.now,
        })
        .where(
          and(
            eq(documentShareLinks.id, input.id),
            isNull(documentShareLinks.revokedAt),
            gt(documentShareLinks.expiresAt, input.now),
            or(
              isNull(documentShareLinks.maxUses),
              lt(documentShareLinks.useCount, documentShareLinks.maxUses),
            ),
          ),
        )
        .returning({ id: documentShareLinks.id });

      if (!updated) {
        return null;
      }
      return loadWithCreatorById(updated.id, tx);
    },
  };
}
