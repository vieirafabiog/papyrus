import { describe, expect, it, vi } from "vitest";
import type { AuditEventInput, AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { DocumentRepositoryPort } from "../ports/document-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import {
  type DocumentCommentEntity,
  type DocumentCommentRepositoryPort,
  createDocumentCommentService,
} from "./document-comments.js";
import type { DocumentEntity } from "./document.types.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const AUTHOR_ID = "550e8400-e29b-41d4-a716-446655440010";
const COLLEAGUE_ID = "550e8400-e29b-41d4-a716-446655440011";
const OTHER_USER_ID = "550e8400-e29b-41d4-a716-446655440012";
const COMMENT_ID = "550e8400-e29b-41d4-a716-446655440020";

function makeDoc(status: DocumentEntity["status"] = "APPROVED"): DocumentEntity {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Contrato Principal",
    categoryId: "550e8400-e29b-41d4-a716-446655440099",
    folderId: null,
    status,
    currentVersionId: null,
    ownerUserId: AUTHOR_ID,
    issueDate: null,
    expirationDate: null,
    metadata: {},
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("DocumentCommentService", () => {
  it("persists comments, validates same-org active mentions, excludes author self-mentions from notifications, and writes audit", async () => {
    const audits: AuditEventInput[] = [];
    const notifyMock = vi.fn(async () => undefined);
    const createdRecords: DocumentCommentEntity[] = [];

    const transactions: TransactionManagerPort = {
      async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
        return fn({} as TransactionContext);
      },
    };

    const service = createDocumentCommentService({
      documents: {
        findById: vi.fn(async () => makeDoc("APPROVED")),
      } as unknown as DocumentRepositoryPort,
      comments: {
        listByDocument: vi.fn(),
        findById: vi.fn(),
        softDelete: vi.fn(),
        listActiveMentionCandidates: vi.fn(),
        filterActiveOrganizationUsers: vi.fn(
          async ({
            userIds,
          }: { readonly organizationId: string; readonly userIds: readonly string[] }) =>
            userIds
              .filter((id: string) => id === AUTHOR_ID || id === COLLEAGUE_ID)
              .map((id: string) => ({
                id,
                fullName: id === AUTHOR_ID ? "Ana Gestora" : "Maria Silva",
                email: id === AUTHOR_ID ? "ana@papyrus.local" : "maria@papyrus.local",
              })),
        ),
        create: vi.fn(
          async (input: {
            readonly id: string;
            readonly organizationId: string;
            readonly documentId: string;
            readonly authorUserId: string;
            readonly body: string;
            readonly mentionedUserIds: readonly string[];
            readonly createdAt: Date;
          }) => {
            const entity: DocumentCommentEntity = {
              id: input.id,
              organizationId: input.organizationId,
              documentId: input.documentId,
              author: {
                id: input.authorUserId,
                fullName: "Ana Gestora",
                email: "ana@papyrus.local",
              },
              body: input.body,
              mentions: input.mentionedUserIds.map((userId: string) => ({
                userId,
                fullName: userId === AUTHOR_ID ? "Ana Gestora" : "Maria Silva",
                email: userId === AUTHOR_ID ? "ana@papyrus.local" : "maria@papyrus.local",
              })),
              deletedAt: null,
              createdAt: input.createdAt.toISOString(),
              updatedAt: input.createdAt.toISOString(),
            };
            createdRecords.push(entity);
            return entity;
          },
        ),
      } as unknown as DocumentCommentRepositoryPort,
      transactions,
      audit: {
        append: vi.fn(async (input) => {
          audits.push(input);
          return { id: "audit-1", occurredAt: "2026-01-01T00:00:00Z", ...input };
        }),
        list: vi.fn(),
      } as unknown as AuditRepositoryPort,
      mentionNotifier: { notifyCommentMention: notifyMock },
      generateId: () => COMMENT_ID,
      now: () => new Date("2026-11-25T12:00:00.000Z"),
    });

    const created = await service.createComment({
      organizationId: ORG_ID,
      documentId: DOC_ID,
      actorUserId: AUTHOR_ID,
      actorDisplayName: "Ana Gestora",
      requestId: "req-1",
      body: "Favor revisar @Maria Silva e @Ana Gestora",
      mentionedUserIds: [AUTHOR_ID, COLLEAGUE_ID, OTHER_USER_ID],
    });

    expect(created.id).toBe(COMMENT_ID);
    expect(createdRecords).toHaveLength(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserIds: [COLLEAGUE_ID],
        commentId: COMMENT_ID,
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "DOCUMENT_COMMENT_CREATED",
      resourceType: "DOCUMENT",
      resourceId: DOC_ID,
      metadata: { commentId: COMMENT_ID, mentionCount: 2 },
    });
  });

  it("blocks commenting on deleted documents and restricts deletion to author or moderators", async () => {
    const transactions: TransactionManagerPort = {
      async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
        return fn({} as TransactionContext);
      },
    };

    const existingComment: DocumentCommentEntity = {
      id: COMMENT_ID,
      organizationId: ORG_ID,
      documentId: DOC_ID,
      author: { id: AUTHOR_ID, fullName: "Ana Gestora", email: "ana@papyrus.local" },
      body: "Texto original",
      mentions: [],
      deletedAt: null,
      createdAt: "2026-11-25T10:00:00.000Z",
      updatedAt: "2026-11-25T10:00:00.000Z",
    };

    const serviceDeleted = createDocumentCommentService({
      documents: {
        findById: vi.fn(async () => makeDoc("DELETED")),
      } as unknown as DocumentRepositoryPort,
      comments: {} as DocumentCommentRepositoryPort,
      transactions,
      audit: { append: vi.fn(), list: vi.fn() } as unknown as AuditRepositoryPort,
      generateId: () => COMMENT_ID,
    });

    await expect(
      serviceDeleted.createComment({
        organizationId: ORG_ID,
        documentId: DOC_ID,
        actorUserId: AUTHOR_ID,
        actorDisplayName: "Ana Gestora",
        requestId: "req-2",
        body: "Comentário em lixeira",
        mentionedUserIds: [],
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_DELETED_COMMENT_FORBIDDEN" });

    const softDeleteMock = vi.fn(async () => true);
    const serviceActive = createDocumentCommentService({
      documents: {
        findById: vi.fn(async () => makeDoc("APPROVED")),
      } as unknown as DocumentRepositoryPort,
      comments: {
        findById: vi.fn(async () => existingComment),
        softDelete: softDeleteMock,
      } as unknown as DocumentCommentRepositoryPort,
      transactions,
      audit: {
        append: vi.fn(async (input) => ({
          id: "a2",
          occurredAt: "2026-01-01T00:00:00Z",
          ...input,
        })),
        list: vi.fn(),
      } as unknown as AuditRepositoryPort,
      generateId: () => COMMENT_ID,
    });

    await expect(
      serviceActive.deleteComment({
        organizationId: ORG_ID,
        documentId: DOC_ID,
        commentId: COMMENT_ID,
        actorUserId: OTHER_USER_ID,
        canModerateComments: false,
        requestId: "req-3",
      }),
    ).rejects.toMatchObject({ code: "COMMENT_DELETE_FORBIDDEN" });

    const deleted = await serviceActive.deleteComment({
      organizationId: ORG_ID,
      documentId: DOC_ID,
      commentId: COMMENT_ID,
      actorUserId: OTHER_USER_ID,
      canModerateComments: true,
      requestId: "req-4",
    });
    expect(deleted.commentId).toBe(COMMENT_ID);
    expect(softDeleteMock).toHaveBeenCalledTimes(1);
  });
});
