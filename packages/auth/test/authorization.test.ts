import { describe, expect, it } from "vitest";
import {
  buildSystemRolePermissionMap,
  evaluateAuthorization,
  PERMISSION_CATALOG,
  roleGrantsPermission,
  SYSTEM_ROLE_DEFINITIONS,
} from "../src/index.js";

describe("Role catalog and default-deny authorization", () => {
  const rolePermissions = buildSystemRolePermissionMap();

  it("denies by default when user has no assignments or insufficient role permissions", () => {
    const decisionEmpty = evaluateAuthorization(
      { userId: "u1", organizationId: "org1", assignments: [] },
      { action: "READ", resource: "DOCUMENT", scope: { type: "GLOBAL" } },
      rolePermissions,
    );
    expect(decisionEmpty.allowed).toBe(false);
    expect(decisionEmpty.effect).toBe("DENY");

    const viewerDecision = evaluateAuthorization(
      {
        userId: "u1",
        organizationId: "org1",
        assignments: [{ roleId: "viewer", scope: { type: "GLOBAL" }, effect: "ALLOW", source: "USER" }],
      },
      { action: "DELETE", resource: "DOCUMENT", scope: { type: "GLOBAL" } },
      rolePermissions,
    );
    expect(viewerDecision.allowed).toBe(false);
  });

  it("grants access when action + resource + scope match and enforces explicit DENY precedence", () => {
    const allowedDecision = evaluateAuthorization(
      {
        userId: "u1",
        organizationId: "org1",
        assignments: [
          {
            roleId: "collaborator",
            scope: { type: "CATEGORY", categoryId: "cat-1" },
            effect: "ALLOW",
            source: "USER",
          },
        ],
      },
      { action: "CREATE", resource: "DOCUMENT", scope: { type: "CATEGORY", categoryId: "cat-1" } },
      rolePermissions,
    );
    expect(allowedDecision.allowed).toBe(true);

    const wrongCategoryDecision = evaluateAuthorization(
      {
        userId: "u1",
        organizationId: "org1",
        assignments: [
          {
            roleId: "collaborator",
            scope: { type: "CATEGORY", categoryId: "cat-1" },
            effect: "ALLOW",
            source: "USER",
          },
        ],
      },
      { action: "CREATE", resource: "DOCUMENT", scope: { type: "CATEGORY", categoryId: "cat-2" } },
      rolePermissions,
    );
    expect(wrongCategoryDecision.allowed).toBe(false);

    // Explicit DENY beats ALLOW
    const deniedDecision = evaluateAuthorization(
      {
        userId: "u1",
        organizationId: "org1",
        assignments: [
          { roleId: "admin", scope: { type: "GLOBAL" }, effect: "ALLOW", source: "USER" },
          { roleId: "viewer", scope: { type: "DOCUMENT", documentId: "doc-1" }, effect: "DENY", source: "GROUP" },
        ],
      },
      { action: "READ", resource: "DOCUMENT", scope: { type: "DOCUMENT", documentId: "doc-1" } },
      rolePermissions,
    );
    expect(deniedDecision.allowed).toBe(false);
    expect(deniedDecision.effect).toBe("DENY");
  });

  it("exposes expected system roles and permission catalog", () => {
    expect(PERMISSION_CATALOG.length).toBeGreaterThan(20);
    expect(roleGrantsPermission(SYSTEM_ROLE_DEFINITIONS.admin.permissions, "MANAGE_STORAGE", "STORAGE")).toBe(true);
    expect(roleGrantsPermission(SYSTEM_ROLE_DEFINITIONS.reviewer.permissions, "APPROVE", "WORKFLOW")).toBe(true);
    expect(roleGrantsPermission(SYSTEM_ROLE_DEFINITIONS.viewer.permissions, "CREATE", "DOCUMENT")).toBe(false);
  });
});
