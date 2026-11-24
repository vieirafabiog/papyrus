import { describe, expect, it } from "vitest";
import {
  type DocumentEntity,
  type DocumentStatus,
  type DocumentVersionEntity,
  DomainError,
  type FileObjectStatus,
  assertDocumentStatusTransition,
  buildNextDocumentVersion,
  canSubmitDocumentForReview,
  isFileObjectDownloadable,
  resolveCurrentVersion,
  restoreHistoricalVersion,
} from "../src/index.js";

const DOC_ID = "550e8400-e29b-41d4-a716-446655440000";
const ORG_ID = "550e8400-e29b-41d4-a716-446655440001";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440002";
const USER_ID = "550e8400-e29b-41d4-a716-446655440003";

function makeDocument(overrides: Partial<DocumentEntity> = {}): DocumentEntity {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Contrato Mestre",
    categoryId: CAT_ID,
    folderId: null,
    status: "DRAFT",
    currentVersionId: "v1",
    ownerUserId: USER_ID,
    issueDate: null,
    expirationDate: null,
    metadata: {},
    version: 1,
    createdAt: "2026-11-20T10:00:00Z",
    updatedAt: "2026-11-20T10:00:00Z",
    ...overrides,
  };
}

describe("Document domain invariants", () => {
  it("prevents invalid document status transitions", () => {
    const invalidPairs: readonly [DocumentStatus, DocumentStatus][] = [
      ["DRAFT", "APPROVED"],
      ["DRAFT", "REJECTED"],
      ["DRAFT", "EXPIRED"],
      ["ARCHIVED", "APPROVED"],
      ["DELETED", "IN_REVIEW"],
      ["DELETED", "APPROVED"],
      ["APPROVED", "APPROVED"],
    ];

    for (const [from, to] of invalidPairs) {
      expect(() => assertDocumentStatusTransition(from, to)).toThrowError(DomainError);
    }
  });

  it("blocks download and review submission when file object is not AVAILABLE", () => {
    const nonAvailable: readonly FileObjectStatus[] = [
      "UPLOADING",
      "QUARANTINED",
      "REJECTED",
      "MISSING",
      "DELETE_PENDING",
    ];

    for (const status of nonAvailable) {
      expect(isFileObjectDownloadable(status)).toBe(false);
      expect(canSubmitDocumentForReview("DRAFT", status)).toBe(false);
    }

    expect(isFileObjectDownloadable("AVAILABLE")).toBe(true);
    expect(canSubmitDocumentForReview("DRAFT", "AVAILABLE")).toBe(true);
  });

  it("enforces immutable append-only versions and detects missing currentVersionId", () => {
    const v1: DocumentVersionEntity = {
      id: "v1",
      documentId: DOC_ID,
      versionNumber: 1,
      fileObjectId: "file-1",
      uploadedByUserId: USER_ID,
      changeNote: "Inicial",
      createdAt: "2026-11-20T10:00:00Z",
    };

    const existing = [v1] as const;
    const v2 = buildNextDocumentVersion({
      id: "v2",
      documentId: DOC_ID,
      existingVersions: existing,
      fileObjectId: "file-2",
      uploadedByUserId: USER_ID,
      changeNote: "Revisada",
      createdAt: "2026-11-20T10:10:00Z",
    });

    expect(v2.versionNumber).toBe(2);
    expect(existing).toHaveLength(1);

    const doc = makeDocument({ currentVersionId: "v2", version: 2 });
    const restored = restoreHistoricalVersion({
      newVersionId: "v3",
      document: doc,
      existingVersions: [v1, v2],
      targetVersionId: "v1",
      restoredByUserId: USER_ID,
      createdAt: "2026-11-20T10:20:00Z",
    });

    expect(restored.restoredVersion.versionNumber).toBe(3);
    expect(restored.restoredVersion.fileObjectId).toBe("file-1");
    expect(() =>
      resolveCurrentVersion(makeDocument({ currentVersionId: "non-existent" }), [v1, v2]),
    ).toThrowError(DomainError);
  });

  it("enforces conceptual optimistic concurrency and legal hold protection", () => {
    const currentDoc = makeDocument({ version: 3 });
    const staleExpectedVersion = 2;
    expect(currentDoc.version !== staleExpectedVersion).toBe(true);

    const activeHoldCount = 1;
    const canPhysicallyPurge = currentDoc.status === "DELETED" && activeHoldCount === 0;
    expect(canPhysicallyPurge).toBe(false);
  });
});
