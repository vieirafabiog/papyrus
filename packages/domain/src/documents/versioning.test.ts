import { describe, expect, it } from "vitest";
import {
  assertApprovalMatchesVersion,
  buildNextDocumentVersion,
  type DocumentEntity,
  type DocumentVersionEntity,
  DomainError,
  getNextVersionNumber,
  resolveCurrentVersion,
  restoreHistoricalVersion,
  type WorkflowInstanceEntity,
} from "../index.js";

const DOC_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "550e8400-e29b-41d4-a716-446655440010";

const BASE_DOC: DocumentEntity = {
  id: DOC_ID,
  organizationId: "550e8400-e29b-41d4-a716-446655440001",
  title: "Contrato",
  categoryId: "550e8400-e29b-41d4-a716-446655440002",
  folderId: null,
  status: "DRAFT",
  currentVersionId: "v2",
  ownerUserId: USER_ID,
  issueDate: null,
  expirationDate: null,
  metadata: {},
  version: 2,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:05:00Z",
};

const VERSIONS: readonly DocumentVersionEntity[] = [
  {
    id: "v1",
    documentId: DOC_ID,
    versionNumber: 1,
    fileObjectId: "file-1",
    uploadedByUserId: USER_ID,
    changeNote: "Inicial",
    createdAt: "2026-11-20T10:00:00Z",
  },
  {
    id: "v2",
    documentId: DOC_ID,
    versionNumber: 2,
    fileObjectId: "file-2",
    uploadedByUserId: USER_ID,
    changeNote: "Revisão",
    createdAt: "2026-11-20T10:05:00Z",
  },
];

describe("Immutable document versioning", () => {
  it("computes next version number and enforces new file object for new uploads", () => {
    expect(getNextVersionNumber([])).toBe(1);
    expect(getNextVersionNumber(VERSIONS)).toBe(3);

    const v3 = buildNextDocumentVersion({
      id: "v3",
      documentId: DOC_ID,
      existingVersions: VERSIONS,
      fileObjectId: "file-3",
      uploadedByUserId: USER_ID,
      changeNote: "Atualização",
      createdAt: "2026-11-20T10:10:00Z",
    });

    expect(v3.versionNumber).toBe(3);
    expect(v3.fileObjectId).toBe("file-3");

    expect(() =>
      buildNextDocumentVersion({
        id: "v3",
        documentId: DOC_ID,
        existingVersions: VERSIONS,
        fileObjectId: "file-2",
        uploadedByUserId: USER_ID,
        changeNote: null,
        createdAt: "2026-11-20T10:10:00Z",
      }),
    ).toThrowError(DomainError);
  });

  it("resolves current version and restores historical versions as new append-only versions", () => {
    const current = resolveCurrentVersion(BASE_DOC, VERSIONS);
    expect(current?.id).toBe("v2");

    const restored = restoreHistoricalVersion({
      newVersionId: "v3",
      document: BASE_DOC,
      existingVersions: VERSIONS,
      targetVersionId: "v1",
      restoredByUserId: USER_ID,
      createdAt: "2026-11-20T10:15:00Z",
    });

    expect(restored.sourceVersion.id).toBe("v1");
    expect(restored.restoredVersion.versionNumber).toBe(3);
    expect(restored.restoredVersion.fileObjectId).toBe("file-1");
    expect(restored.restoredVersion.changeNote).toContain("versão 1");
  });

  it("binds workflow approval strictly to the version that started the instance", () => {
    const instance: WorkflowInstanceEntity = {
      id: "wf-1",
      documentId: DOC_ID,
      documentVersionId: "v1",
      workflowDefinitionVersionId: "def-1",
      status: "ACTIVE",
      currentStepOrder: 1,
      startedByUserId: USER_ID,
      startedAt: "2026-11-20T10:01:00Z",
      completedAt: null,
    };

    expect(() => assertApprovalMatchesVersion(instance, BASE_DOC, "v1")).not.toThrow();
    expect(() => assertApprovalMatchesVersion(instance, BASE_DOC, "v2")).toThrowError(DomainError);
  });
});
