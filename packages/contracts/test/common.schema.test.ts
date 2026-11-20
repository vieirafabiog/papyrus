import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  apiErrorResponseSchema,
  createApiResponseSchema,
  createPaginatedResponseSchema,
  createSortSchema,
  isoDateSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
} from "../src/index.js";

describe("Common contracts schemas", () => {
  it("validates UUIDs and rejects invalid values", () => {
    expect(uuidSchema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(true);
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  it("validates ISO date and datetime strings", () => {
    expect(isoDateSchema.safeParse("2026-11-20").success).toBe(true);
    expect(isoDateSchema.safeParse("2026-02-30").success).toBe(false);
    expect(isoDateTimeSchema.safeParse("2026-11-20T13:30:00Z").success).toBe(true);
    expect(isoDateTimeSchema.safeParse("2026-11-20").success).toBe(false);
  });

  it("applies defaults and bounds for pagination and sorting", () => {
    const query = paginationQuerySchema.parse({});
    expect(query).toEqual({ page: 1, pageSize: 20 });
    expect(paginationQuerySchema.safeParse({ page: 0, pageSize: 101 }).success).toBe(false);

    const sortSchema = createSortSchema(["title", "createdAt", "id"]);
    expect(sortSchema.parse({ sortBy: "title" })).toEqual({
      sortBy: "title",
      sortDirection: "desc",
    });
    expect(sortSchema.safeParse({ sortBy: "arbitraryColumn" }).success).toBe(false);
  });

  it("validates standard response and error envelopes", () => {
    const itemSchema = z.object({ id: uuidSchema });
    const paginatedSchema = createPaginatedResponseSchema(itemSchema);
    const singleSchema = createApiResponseSchema(itemSchema);

    expect(
      paginatedSchema.safeParse({
        items: [{ id: "550e8400-e29b-41d4-a716-446655440000" }],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      }).success,
    ).toBe(true);

    expect(
      singleSchema.safeParse({
        data: { id: "550e8400-e29b-41d4-a716-446655440000" },
      }).success,
    ).toBe(true);

    expect(
      apiErrorResponseSchema.safeParse({
        error: {
          code: "DOCUMENT_VERSION_CONFLICT",
          message: "O documento foi atualizado por outra pessoa.",
          requestId: "550e8400-e29b-41d4-a716-446655440000",
        },
      }).success,
    ).toBe(true);
  });
});
