import { describe, expect, it } from "vitest";
import {
  documentListQuerySchema,
  documentRecordSchema,
  documentStatusSchema,
  documentVersionRecordSchema,
  fileObjectRecordSchema,
  fileObjectStatusSchema,
} from "../src/index.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_SHA256 = "a".repeat(64);

describe("Document and version contracts schemas", () => {
  it("separates document statuses from file object statuses", () => {
    expect(documentStatusSchema.options).toEqual([
      "DRAFT",
      "IN_REVIEW",
      "APPROVED",
      "REJECTED",
      "ARCHIVED",
      "EXPIRED",
      "DELETED",
    ]);
    expect(fileObjectStatusSchema.options).toEqual([
      "UPLOADING",
      "QUARANTINED",
      "AVAILABLE",
      "REJECTED",
      "MISSING",
      "DELETE_PENDING",
    ]);
  });

  it("validates DocumentRecord, DocumentVersionRecord, and FileObjectRecord", () => {
    expect(
      documentRecordSchema.safeParse({
        id: VALID_UUID,
        organizationId: VALID_UUID,
        title: "Contrato de Fornecimento",
        categoryId: VALID_UUID,
        folderId: null,
        status: "DRAFT",
        currentVersionId: null,
        ownerUserId: VALID_UUID,
        issueDate: "2026-11-20",
        expirationDate: "2027-11-20",
        metadata: { fornecedor: "Empresa ACME", valor: 15000 },
        version: 1,
        createdAt: "2026-11-20T10:00:00Z",
        updatedAt: "2026-11-20T10:00:00Z",
      }).success,
    ).toBe(true);

    expect(
      documentVersionRecordSchema.safeParse({
        id: VALID_UUID,
        documentId: VALID_UUID,
        versionNumber: 1,
        fileObjectId: VALID_UUID,
        uploadedByUserId: VALID_UUID,
        changeNote: "Versão inicial",
        createdAt: "2026-11-20T10:00:00Z",
      }).success,
    ).toBe(true);

    expect(
      fileObjectRecordSchema.safeParse({
        id: VALID_UUID,
        storageConnectionId: VALID_UUID,
        objectKey: `org/${VALID_UUID}/documents/${VALID_UUID}/versions/${VALID_UUID}/${VALID_UUID}`,
        originalFileName: "contrato.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: VALID_SHA256,
        status: "QUARANTINED",
        createdAt: "2026-11-20T10:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("rejects invalid checksum and unsupported sort fields", () => {
    expect(
      fileObjectRecordSchema.safeParse({
        id: VALID_UUID,
        storageConnectionId: VALID_UUID,
        objectKey: "org/1/documents/2/versions/3/4",
        originalFileName: "contrato.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: "invalid-checksum",
        status: "AVAILABLE",
        createdAt: "2026-11-20T10:00:00Z",
      }).success,
    ).toBe(false);

    expect(documentListQuerySchema.safeParse({ sortBy: "passwordHash" }).success).toBe(false);
  });
});
