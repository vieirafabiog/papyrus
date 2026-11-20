import { describe, expect, it } from "vitest";
import {
  ACCESS_ACTIONS,
  ACCESS_EFFECTS,
  ACCESS_RESOURCES,
  ACCESS_SCOPE_TYPES,
  type AccessScope,
  USER_STATUSES,
} from "../src/index.js";

describe("Access and session domain types", () => {
  it("exposes expected actions, resources, scopes, effects, and user statuses", () => {
    expect(ACCESS_ACTIONS).toContain("READ");
    expect(ACCESS_ACTIONS).toContain("DOWNLOAD");
    expect(ACCESS_ACTIONS).toContain("MANAGE_STORAGE");
    expect(ACCESS_RESOURCES).toContain("DOCUMENT");
    expect(ACCESS_RESOURCES).toContain("FOLDER");
    expect(ACCESS_SCOPE_TYPES).toEqual(["GLOBAL", "CATEGORY", "FOLDER", "DOCUMENT"]);
    expect(ACCESS_EFFECTS).toEqual(["ALLOW", "DENY"]);
    expect(USER_STATUSES).toEqual(["ACTIVE", "INACTIVE", "LOCKED"]);
  });

  it("supports discriminated access scopes", () => {
    const scopes: readonly AccessScope[] = [
      { type: "GLOBAL" },
      { type: "CATEGORY", categoryId: "550e8400-e29b-41d4-a716-446655440000" },
      { type: "FOLDER", folderId: "550e8400-e29b-41d4-a716-446655440001" },
      { type: "DOCUMENT", documentId: "550e8400-e29b-41d4-a716-446655440002" },
    ];

    expect(scopes.map((scope) => scope.type)).toEqual([
      "GLOBAL",
      "CATEGORY",
      "FOLDER",
      "DOCUMENT",
    ]);
  });
});
