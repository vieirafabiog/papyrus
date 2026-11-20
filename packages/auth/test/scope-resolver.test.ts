import { describe, expect, it } from "vitest";
import {
  buildSystemRolePermissionMap,
  evaluateDocumentAuthorization,
  evaluateFolderAuthorization,
} from "../src/index.js";

describe("Scope inheritance and explicit deny precedence", () => {
  const rolePermissions = buildSystemRolePermissionMap();

  it("inherits ALLOW from ancestor folders into subfolders and documents", () => {
    const subject = {
      userId: "user-1",
      organizationId: "org-1",
      assignments: [
        {
          roleId: "viewer",
          scope: { type: "FOLDER" as const, folderId: "folder-root" },
          effect: "ALLOW" as const,
          source: "GROUP" as const,
        },
      ],
    };

    const folderDecision = evaluateFolderAuthorization(
      subject,
      "READ",
      { folderId: "folder-leaf", ancestorFolderIds: ["folder-mid", "folder-root"] },
      rolePermissions,
    );
    expect(folderDecision.allowed).toBe(true);

    const docDecision = evaluateDocumentAuthorization(
      subject,
      "DOWNLOAD",
      {
        documentId: "doc-1",
        categoryId: "cat-1",
        folderAncestorIds: ["folder-leaf", "folder-mid", "folder-root"],
      },
      rolePermissions,
    );
    expect(docDecision.allowed).toBe(true);
  });

  it("enforces formal precedence of explicit DENY over inherited folder or category ALLOW", () => {
    const subjectWithDocDeny = {
      userId: "user-1",
      organizationId: "org-1",
      assignments: [
        {
          roleId: "document_manager",
          scope: { type: "FOLDER" as const, folderId: "folder-root" },
          effect: "ALLOW" as const,
          source: "USER" as const,
        },
        {
          roleId: "viewer",
          scope: { type: "DOCUMENT" as const, documentId: "doc-secret" },
          effect: "DENY" as const,
          source: "USER" as const,
        },
      ],
    };

    const deniedDoc = evaluateDocumentAuthorization(
      subjectWithDocDeny,
      "READ",
      {
        documentId: "doc-secret",
        categoryId: "cat-1",
        folderAncestorIds: ["folder-leaf", "folder-root"],
      },
      rolePermissions,
    );
    expect(deniedDoc.allowed).toBe(false);
    expect(deniedDoc.effect).toBe("DENY");

    // Sibling document in the same folder remains allowed
    const allowedSibling = evaluateDocumentAuthorization(
      subjectWithDocDeny,
      "READ",
      {
        documentId: "doc-normal",
        categoryId: "cat-1",
        folderAncestorIds: ["folder-leaf", "folder-root"],
      },
      rolePermissions,
    );
    expect(allowedSibling.allowed).toBe(true);
  });

  it("denies access to subfolder when explicit DENY is placed on an intermediate folder", () => {
    const subject = {
      userId: "user-1",
      organizationId: "org-1",
      assignments: [
        {
          roleId: "collaborator",
          scope: { type: "CATEGORY" as const, categoryId: "cat-contracts" },
          effect: "ALLOW" as const,
          source: "USER" as const,
        },
        {
          roleId: "collaborator",
          scope: { type: "FOLDER" as const, folderId: "folder-restricted" },
          effect: "DENY" as const,
          source: "GROUP" as const,
        },
      ],
    };

    const decision = evaluateDocumentAuthorization(
      subject,
      "UPDATE",
      {
        documentId: "doc-99",
        categoryId: "cat-contracts",
        folderAncestorIds: ["folder-child", "folder-restricted", "folder-root"],
      },
      rolePermissions,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.effect).toBe("DENY");
  });
});
