import { describe, expect, it } from "vitest";
import {
  DomainError,
  assertDocumentStatusTransition,
  canSubmitDocumentForReview,
  canTransitionDocumentStatus,
  isFileObjectDownloadable,
} from "../index.js";

describe("Document state transitions", () => {
  it("allows valid transitions and rejects arbitrary transitions", () => {
    expect(canTransitionDocumentStatus("DRAFT", "IN_REVIEW")).toBe(true);
    expect(canTransitionDocumentStatus("IN_REVIEW", "APPROVED")).toBe(true);
    expect(canTransitionDocumentStatus("APPROVED", "EXPIRED")).toBe(true);

    expect(canTransitionDocumentStatus("DRAFT", "APPROVED")).toBe(false);
    expect(canTransitionDocumentStatus("DRAFT", "DRAFT")).toBe(false);
    expect(canTransitionDocumentStatus("DELETED", "APPROVED")).toBe(false);

    expect(() => assertDocumentStatusTransition("DRAFT", "APPROVED")).toThrowError(DomainError);
  });

  it("keeps file object status independent from document status", () => {
    expect(isFileObjectDownloadable("AVAILABLE")).toBe(true);
    expect(isFileObjectDownloadable("QUARANTINED")).toBe(false);
    expect(isFileObjectDownloadable("REJECTED")).toBe(false);
    expect(isFileObjectDownloadable("UPLOADING")).toBe(false);
    expect(isFileObjectDownloadable("MISSING")).toBe(false);
    expect(isFileObjectDownloadable("DELETE_PENDING")).toBe(false);

    expect(canSubmitDocumentForReview("DRAFT", "AVAILABLE")).toBe(true);
    expect(canSubmitDocumentForReview("DRAFT", "QUARANTINED")).toBe(false);
    expect(canSubmitDocumentForReview("DRAFT", null)).toBe(false);
  });
});
