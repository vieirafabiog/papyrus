import { SYSTEM_ROLE_DEFINITIONS } from "@papyrus/auth";
import { CONTRACTS_API_PREFIX } from "@papyrus/contracts";
import type {
  AuditEventInput,
  AuditRepositoryPort,
  DocumentCommentEntity,
  DocumentCommentRepositoryPort,
  DocumentEntity,
  DocumentRepositoryPort,
  TransactionContext,
  TransactionManagerPort,
} from "@papyrus/domain";
import { createDocumentCommentService } from "@papyrus/domain";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerDocumentCommentRoutes } from "../src/modules/documents/comments.routes.js";
import type { DocumentAuthorizationGuard } from "../src/plugins/authorization.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440009";
const READER_ID = "550e8400-e29b-41d4-a716-446655440010";
const EDITOR_ID = "550e8400-e29b-41d4-a716-446655440011";
const MENTIONED_ID = "550e8400-e29b-41d4-a716-446655440012";
const COMMENT_1_ID = "550e8400-e29b-41d4-a716-446655440021";

function makeDoc(status: DocumentEntity["status"] = "APPROVED"): DocumentEntity {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Contrato de Serviços",
    categoryId: CAT_ID,
    folderId: null,
    status,
    currentVersionId: null,
    ownerUserId: EDITOR_ID,
    issueDate: null,
    expirationDate: null,
    metadata: {},
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

async function createCommentsRouteHarness(options: {
  readonly actorRole: "viewer" | "editor";
  readonly actorId: string;
  readonly docStatus?: DocumentEntity["status"];
}) {
  const app = Fastify({ logger: false });
  const doc = makeDoc(options.docStatus ?? "APPROVED");

  const storedComments: DocumentCommentEntity[] = [
    {
      id: COMMENT_1_ID,
      organizationId: ORG_ID,
      documentId: DOC_ID,
      author: { id: EDITOR_ID, fullName: "Carlos Editor", email: "carlos@papyrus.local" },
      body: "Favor validar a cláusula 4 @Maria Leitora",
      mentions: [{ userId: MENTIONED_ID, fullName: "Maria Leitora", email: "maria@papyrus.local" }],
      deletedAt: null,
      createdAt: "2026-11-25T10:00:00.000Z",
      updatedAt: "2026-11-25T10:00:00.000Z",
    },
  ];

  const notifySpy = vi.fn(async () => undefined);
  const roleId = "role-1";
  const rolePerms = new Map([
    [
      roleId,
      options.actorRole === "editor"
        ? [...SYSTEM_ROLE_DEFINITIONS.document_manager.permissions]
        : [...SYSTEM_ROLE_DEFINITIONS.viewer.permissions],
    ],
  ]);

  const guard = {
    requireSubject: vi.fn(async () => ({
      me: {
        user: {
          id: options.actorId,
          organizationId: ORG_ID,
          email: options.actorRole === "editor" ? "carlos@papyrus.local" : "maria@papyrus.local",
          fullName: options.actorRole === "editor" ? "Carlos Editor" : "Maria Leitora",
          status: "ACTIVE",
        },
        groups: [],
        roles: [],
        permissions: [],
      },
      subject: {
        userId: options.actorId,
        organizationId: ORG_ID,
        assignments: [
          {
            roleId,
            scope: { type: "GLOBAL" as const },
            effect: "ALLOW" as const,
            source: "DIRECT" as const,
          },
        ],
      },
      rolePermissions: rolePerms,
    })),
    authorizeDocument: vi.fn(async (_ctx, id: string, _action, reply) => {
      if (id !== DOC_ID) {
        void reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Documento não encontrado.", requestId: "r" },
        });
        return null;
      }
      return doc;
    }),
  } as unknown as DocumentAuthorizationGuard;

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({} as TransactionContext);
    },
  };

  const commentRepository: DocumentCommentRepositoryPort = {
    async listByDocument({ page, pageSize }) {
      const visible = storedComments.filter((c) => c.deletedAt === null);
      return {
        items: visible,
        page,
        pageSize,
        totalItems: visible.length,
        totalPages: 1,
      };
    },
    async findById(id) {
      return storedComments.find((c) => c.id === id) ?? null;
    },
    async create(input) {
      const created: DocumentCommentEntity = {
        id: input.id,
        organizationId: input.organizationId,
        documentId: input.documentId,
        author: {
          id: input.authorUserId,
          fullName: options.actorRole === "editor" ? "Carlos Editor" : "Maria Leitora",
          email: options.actorRole === "editor" ? "carlos@papyrus.local" : "maria@papyrus.local",
        },
        body: input.body,
        mentions: input.mentionedUserIds.map((userId) => ({
          userId,
          fullName: userId === MENTIONED_ID ? "Maria Leitora" : "Carlos Editor",
          email: userId === MENTIONED_ID ? "maria@papyrus.local" : "carlos@papyrus.local",
        })),
        deletedAt: null,
        createdAt: input.createdAt.toISOString(),
        updatedAt: input.createdAt.toISOString(),
      };
      storedComments.push(created);
      return created;
    },
    async softDelete({ id, deletedAt }) {
      const idx = storedComments.findIndex((c) => c.id === id);
      const current = idx >= 0 ? storedComments[idx] : undefined;
      if (!current) {
        return false;
      }
      storedComments[idx] = { ...current, deletedAt: deletedAt.toISOString() };
      return true;
    },
    async filterActiveOrganizationUsers({ userIds }) {
      return userIds
        .filter((id) => id === MENTIONED_ID || id === EDITOR_ID || id === READER_ID)
        .map((id) => ({
          id,
          fullName: id === EDITOR_ID ? "Carlos Editor" : "Maria Leitora",
          email: id === EDITOR_ID ? "carlos@papyrus.local" : "maria@papyrus.local",
        }));
    },
    async listActiveMentionCandidates({ query }) {
      const all = [
        { id: EDITOR_ID, fullName: "Carlos Editor", email: "carlos@papyrus.local" },
        { id: MENTIONED_ID, fullName: "Maria Leitora", email: "maria@papyrus.local" },
      ];
      const q = (query ?? "").trim().toLowerCase();
      return q.length === 0
        ? all
        : all.filter(
            (u) => u.fullName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
          );
    },
  };

  let generatedSeq = 1;
  const commentService = createDocumentCommentService({
    comments: commentRepository,
    documents: { findById: vi.fn(async () => doc) } as unknown as DocumentRepositoryPort,
    transactions,
    audit: {
      append: vi.fn(async (input: AuditEventInput) => ({
        id: "audit-1",
        occurredAt: "2026-11-25T10:00:00Z",
        ...input,
      })),
      list: vi.fn(),
    } as unknown as AuditRepositoryPort,
    mentionNotifier: { notifyCommentMention: notifySpy },
    generateId: () => `550e8400-e29b-41d4-a716-44665544099${generatedSeq++}`,
  });

  await registerDocumentCommentRoutes(app, { guard, commentService });
  return { app, notifySpy };
}

describe("Document comments & mentions routes", () => {
  it("lists comments with per-actor canDelete flags and searches active mention candidates", async () => {
    const { app: viewerApp } = await createCommentsRouteHarness({
      actorRole: "viewer",
      actorId: READER_ID,
    });

    const listRes = await viewerApp.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/comments`,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().data.items[0]).toMatchObject({
      id: COMMENT_1_ID,
      canDelete: false,
    });

    const candidatesRes = await viewerApp.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/mention-candidates?q=maria`,
    });
    expect(candidatesRes.statusCode).toBe(200);
    expect(candidatesRes.json().data.items).toEqual([
      { id: MENTIONED_ID, fullName: "Maria Leitora", email: "maria@papyrus.local" },
    ]);
  });

  it("creates comment with @mention notification and blocks deletion by non-author viewer (403)", async () => {
    const { app: viewerApp, notifySpy } = await createCommentsRouteHarness({
      actorRole: "viewer",
      actorId: READER_ID,
    });

    const createRes = await viewerApp.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/comments`,
      payload: {
        body: "Concordo com @Carlos Editor",
        mentionedUserIds: [EDITOR_ID],
      },
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().data.canDelete).toBe(true);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // Viewer cannot delete Carlos's existing comment
    const forbiddenDelRes = await viewerApp.inject({
      method: "DELETE",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/comments/${COMMENT_1_ID}`,
    });
    expect(forbiddenDelRes.statusCode).toBe(403);
    expect(forbiddenDelRes.json().error.code).toBe("FORBIDDEN");

    // Editor (can UPDATE document) can delete comment and deleted comments disappear from listing
    const { app: editorApp } = await createCommentsRouteHarness({
      actorRole: "editor",
      actorId: EDITOR_ID,
    });
    const okDelRes = await editorApp.inject({
      method: "DELETE",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/comments/${COMMENT_1_ID}`,
    });
    expect(okDelRes.statusCode).toBe(200);
    expect(okDelRes.json().data).toEqual({ deleted: true, commentId: COMMENT_1_ID });

    const afterListRes = await editorApp.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/comments`,
    });
    expect(afterListRes.json().data.items).toEqual([]);
  });

  it("returns 409 CONFLICT when commenting on a trashed document", async () => {
    const { app } = await createCommentsRouteHarness({
      actorRole: "editor",
      actorId: EDITOR_ID,
      docStatus: "DELETED",
    });

    const res = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/comments`,
      payload: { body: "Tentativa em documento na lixeira" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });
});
