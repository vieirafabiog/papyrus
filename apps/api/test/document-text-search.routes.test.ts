import { SYSTEM_ROLE_DEFINITIONS } from "@papyrus/auth";
import { CONTRACTS_API_PREFIX, documentListResponseSchema } from "@papyrus/contracts";
import type { DocumentSearchFilter, DocumentSearchRepository } from "@papyrus/database";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerDocumentSearchRoutes } from "../src/modules/documents/search.routes.js";
import type { DocumentAuthorizationGuard } from "../src/plugins/authorization.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "550e8400-e29b-41d4-a716-446655440010";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440009";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440020";

describe("Document search routes full-text content & snippets", () => {
  it("passes authorized scope and returns valid documentListResponseSchema with contentSnippet", async () => {
    const app = Fastify({ logger: false });
    const roleId = "role-viewer";
    const capturedFilters: DocumentSearchFilter[] = [];

    const guard = {
      requireSubject: vi.fn(async () => ({
        me: {
          user: {
            id: USER_ID,
            organizationId: ORG_ID,
            email: "viewer@papyrus.local",
            fullName: "Maria Leitora",
            status: "ACTIVE",
          },
          groups: [],
          roles: [],
          permissions: [],
        },
        loaded: {
          userId: USER_ID,
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
        rolePermissions: new Map([[roleId, [...SYSTEM_ROLE_DEFINITIONS.viewer.permissions]]]),
      })),
    } as unknown as DocumentAuthorizationGuard;

    const documentSearchRepository: DocumentSearchRepository = {
      async searchAuthorizedDocuments(filter) {
        capturedFilters.push(filter);
        return {
          items: [
            {
              id: DOC_ID,
              title: "Nota Fiscal Scanned.png",
              categoryId: CAT_ID,
              folderId: null,
              status: "APPROVED",
              currentVersionId: null,
              ownerUserId: USER_ID,
              issueDate: null,
              expirationDate: null,
              version: 1,
              contentSnippet: "Valor total [[HL]]autenticado[[/HL]] via OCR",
              createdAt: "2026-11-20T10:00:00.000Z",
              updatedAt: "2026-11-25T10:00:00.000Z",
            },
          ],
          page: filter.page,
          pageSize: filter.pageSize,
          totalItems: 1,
          totalPages: 1,
        };
      },
    };

    await registerDocumentSearchRoutes(app, { guard, documentSearchRepository });

    const res = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/search?search=autenticado&page=1&pageSize=20`,
    });

    expect(res.statusCode).toBe(200);
    const parsed = documentListResponseSchema.parse(res.json());
    expect(parsed.items[0]?.contentSnippet).toBe("Valor total [[HL]]autenticado[[/HL]] via OCR");
    expect(capturedFilters[0]?.search).toBe("autenticado");
    expect(capturedFilters[0]?.organizationId).toBe(ORG_ID);
  });
});
